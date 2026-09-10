const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

/**
 * Colors and visual tokens matching report.pdf
 */
const THEME = {
  bg: '#ffffff',
  grid: '#f1f5f9',
  border: '#cbd5e1',
  axisText: '#64748b',
  axisLabel: '#475569',
  titleText: '#0f172a',
  footerText: '#94a3b8',
  pemfLine: '#7c3aed',     // Purple
  pemfBadge: '#6b21a8',
  tempLine: '#ef4444',     // Coral / Red
  tempText: '#b91c1c',
  humLine: '#0284c7',      // Blue / Cyan
  humText: '#0369a1',
  dualBadge: '#334155',    // Slate dark
  heartbeatLine: '#10b981', // Emerald
  heartbeatBadge: '#047857'
};

/**
 * Min-Max bucket downsampling to preserve peaks/troughs while keeping vector size optimal
 */
function downsampleTimeseries(points, maxPoints = 1200) {
  if (!points || points.length <= maxPoints) return points;

  const bucketCount = Math.floor(maxPoints / 2);
  const bucketSize = points.length / bucketCount;
  const downsampled = [];

  for (let i = 0; i < bucketCount; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(points.length, Math.floor((i + 1) * bucketSize));
    if (start >= end) continue;

    let minPoint = points[start];
    let maxPoint = points[start];

    for (let j = start + 1; j < end; j++) {
      const p = points[j];
      if (p.value < minPoint.value) minPoint = p;
      if (p.value > maxPoint.value) maxPoint = p;
    }

    // Preserve chronological order between min and max point
    if (minPoint.time <= maxPoint.time) {
      downsampled.push(minPoint);
      if (minPoint !== maxPoint) downsampled.push(maxPoint);
    } else {
      downsampled.push(maxPoint);
      if (minPoint !== maxPoint) downsampled.push(minPoint);
    }
  }

  return downsampled;
}

/**
 * Format timestamp into HH:MM string in UTC+8
 */
function formatTimeUtc8(timestampMs) {
  const d = new Date(timestampMs);
  // Shift to UTC+8 (+8 hours = 28800000 ms)
  const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
  const utc8 = new Date(utc + (8 * 3600000));
  const h = String(utc8.getHours()).padStart(2, '0');
  const m = String(utc8.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Calculate min, max, avg
 */
function computeStats(points) {
  if (!points || points.length === 0) {
    return { min: 0, max: 0, avg: 0, count: 0 };
  }
  let min = points[0].value;
  let max = points[0].value;
  let sum = 0;

  for (let i = 0; i < points.length; i++) {
    const v = points[i].value;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  return {
    min,
    max,
    avg: sum / points.length,
    count: points.length
  };
}

/**
 * Parse raw annotated Influx CSV content or buffer into metric arrays
 */
function parseInfluxCsvForReport(csvContent, filterDate = null) {
  const lines = typeof csvContent === 'string' ? csvContent.split(/\r?\n/) : [];
  const pemfPoints = [];
  const tempPoints = [];
  const humPoints = [];
  const hbPoints = [];

  let detectedDate = filterDate || null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#') || line.startsWith(',result') || line.startsWith('result')) {
      continue;
    }
    const parts = line.split(',');
    if (parts.length < 8) continue;

    // _time is parts[5], _value is parts[6], _field is parts[7], chair_section is parts[9]
    const timeStr = parts[5];
    const valStr = parts[6];
    const field = parts[7];
    const section = parts[9] || '';

    if (!timeStr || !valStr) continue;
    const val = parseFloat(valStr);
    if (isNaN(val)) continue;

    const timeMs = new Date(timeStr).getTime();
    if (isNaN(timeMs)) continue;

    if (!detectedDate) {
      detectedDate = timeStr.slice(0, 10);
    }

    if (filterDate && !timeStr.startsWith(filterDate)) {
      continue;
    }

    // PEMF Current: field current with chair_section PEMF_CUR or field set_pemf / pemf_cur
    if ((field === 'current' && section === 'PEMF_CUR') || field === 'pemf_cur' || field === 'set_pemf') {
      // Auto-scale from mA to A if values are in mA (> 5)
      const currentInAmpere = val > 5 ? val / 1000 : val;
      pemfPoints.push({ time: timeMs, value: currentInAmpere });
    } else if (field === 'temperature' || field === 'chair_temp') {
      tempPoints.push({ time: timeMs, value: val });
    } else if (field === 'humidity' || field === 'chair_hum') {
      humPoints.push({ time: timeMs, value: val });
    } else if (field === 'heartbeat' || field === 'hb' || field.includes('heartbeat')) {
      hbPoints.push({ time: timeMs, value: val });
    }
  }

  // Sort chronological
  const sortFn = (a, b) => a.time - b.time;
  pemfPoints.sort(sortFn);
  tempPoints.sort(sortFn);
  humPoints.sort(sortFn);
  hbPoints.sort(sortFn);

  return {
    date: detectedDate || '2026-09-01',
    pemf: pemfPoints,
    temp: tempPoints,
    hum: humPoints,
    heartbeat: hbPoints
  };
}

/**
 * POD Chart PDF Generator Class
 */
class PodChartPdfService {
  /**
   * Main entrypoint to generate the PDF
   */
  async buildReport({
    dataset,
    options = {},
    outputStream = null,
    outputPath = null
  }) {
    // 1. Prepare data
    const dateStr = options.date || dataset.date || '2026-09-01';
    const moduleName = options.moduleName || 'Chair';
    const moduleId = options.moduleId || '502';
    const sampling = options.sampling || '1s';
    const timezone = options.timeZone || 'UTC+8';

    // Downsample for crisp and fast vector rendering
    const pemfData = downsampleTimeseries(dataset.pemf || []);
    const tempData = downsampleTimeseries(dataset.temp || []);
    const humData = downsampleTimeseries(dataset.hum || []);
    const hbData = downsampleTimeseries(dataset.heartbeat || []);

    // Compute stats
    const pemfStats = computeStats(dataset.pemf || []);
    const tempStats = computeStats(dataset.temp || []);
    const humStats = computeStats(dataset.hum || []);

    // Determine overall time boundary (minTime to maxTime across available metrics)
    let minTime = Infinity;
    let maxTime = -Infinity;

    const allCollections = [dataset.pemf, dataset.temp, dataset.hum, dataset.heartbeat];
    for (const col of allCollections) {
      if (col && col.length > 0) {
        if (col[0].time < minTime) minTime = col[0].time;
        if (col[col.length - 1].time > maxTime) maxTime = col[col.length - 1].time;
      }
    }

    if (!isFinite(minTime) || !isFinite(maxTime) || minTime === maxTime) {
      // Default fallback: 12:00 to 14:00 on the selected date
      const baseMs = new Date(`${dateStr}T04:00:00Z`).getTime();
      minTime = baseMs + 14 * 60000;       // 12:14 UTC+8
      maxTime = baseMs + 119 * 60000;      // 13:59 UTC+8
    }

    // 2. Initialize PDFKit document in 1008x504 Landscape (0 margin prevents unwanted auto page break)
    const doc = new PDFDocument({
      size: [1008, 504],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false,
      bufferPages: true
    });

    const buffers = [];
    let writeStream = null;
    if (!outputStream && !outputPath) {
      doc.on('data', chunk => buffers.push(chunk));
    } else if (outputStream) {
      doc.pipe(outputStream);
    } else if (outputPath) {
      writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);
    }

    const chartBox = {
      x: 60,
      y: 65,
      w: 888,
      h: 360
    };

    const footerText = `Date: ${dateStr} | Module: ${moduleName} (ID${moduleId}) | Sampling: ${sampling} | ${timezone}`;

    // ==========================================
    // PAGE 1: Chair — PEMF Current
    // ==========================================
    doc.addPage();
    this.renderHeader(doc, {
      title: `${moduleName} — PEMF Current`,
      badgeText: `Min: ${pemfStats.min.toFixed(3)} A | Avg: ${pemfStats.avg.toFixed(3)} A | Max: ${pemfStats.max.toFixed(3)} A`,
      badgeBg: THEME.pemfBadge
    });

    this.renderSingleAxisChart(doc, {
      box: chartBox,
      minTime,
      maxTime,
      data: pemfData,
      yMin: 0.0,
      yMax: Math.max(1.0, Math.ceil(pemfStats.max * 1.25 * 10) / 10),
      yTicks: 5,
      yLabel: 'Current (A)',
      lineColor: THEME.pemfLine,
      decimals: 1
    });

    this.renderFooter(doc, footerText);

    // ==========================================
    // PAGE 2: Chair — Temperature & Humidity
    // ==========================================
    doc.addPage();
    const tempText = `Temp -> Min: ${tempStats.min.toFixed(2)}°C | Avg: ${tempStats.avg.toFixed(2)}°C | Max: ${tempStats.max.toFixed(2)}°C`;
    const humText = `Humi -> Min: ${humStats.min.toFixed(2)}% | Avg: ${humStats.avg.toFixed(2)}% | Max: ${humStats.max.toFixed(2)}%`;
    this.renderHeader(doc, {
      title: `${moduleName} — Temperature & Humidity`,
      badgeText: `${tempText}   ${humText}`,
      badgeBg: THEME.dualBadge
    });

    this.renderDualAxisChart(doc, {
      box: chartBox,
      minTime,
      maxTime,
      leftData: tempData,
      leftLabel: 'Temperature (°C)',
      leftColor: THEME.tempLine,
      leftYMin: 0,
      leftYMax: Math.max(40, Math.ceil(tempStats.max * 1.15 / 10) * 10),
      rightData: humData,
      rightLabel: 'Humidity (%RH)',
      rightColor: THEME.humLine,
      rightYMin: 0,
      rightYMax: Math.max(20, Math.ceil(humStats.max * 1.25 / 5) * 5)
    });

    this.renderFooter(doc, footerText);

    // ==========================================
    // PAGE 3: Chair (502) — Heartbeat
    // ==========================================
    doc.addPage();
    this.renderHeader(doc, {
      title: `${moduleName} (${moduleId}) — Heartbeat`,
      badgeText: hbData.length > 0 ? `Heartbeat Points: ${hbData.length}` : null,
      badgeBg: THEME.heartbeatBadge
    });

    this.renderSingleAxisChart(doc, {
      box: chartBox,
      minTime,
      maxTime,
      data: hbData,
      yMin: 0,
      yMax: 100,
      yTicks: 5,
      yLabel: 'Heartbeat Count',
      lineColor: THEME.heartbeatLine,
      decimals: 0,
      emptyMessage: 'No heartbeat data available'
    });

    this.renderFooter(doc, footerText);

    // Finalize
    doc.end();

    return new Promise((resolve, reject) => {
      if (!outputStream && !outputPath) {
        doc.on('end', () => resolve(Buffer.concat(buffers)));
      } else if (writeStream) {
        writeStream.on('finish', () => resolve({ success: true, path: outputPath }));
        writeStream.on('error', reject);
      } else {
        doc.on('end', () => resolve({ success: true }));
      }
      doc.on('error', reject);
    });
  }

  /**
   * Render Page Title & Top Right Badge Pill
   */
  renderHeader(doc, { title, badgeText, badgeBg }) {
    // Title
    doc.fontSize(14)
      .font('Helvetica-Bold')
      .fillColor(THEME.titleText)
      .text(title, 60, 26, { baseline: 'top' });

    // Badge Pill
    if (badgeText) {
      doc.font('Helvetica-Bold').fontSize(8.5);
      const textWidth = doc.widthOfString(badgeText);
      const pillWidth = Math.max(textWidth + 20, 180);
      const pillHeight = 20;
      const pillX = 948 - pillWidth;
      const pillY = 24;

      doc.roundedRect(pillX, pillY, pillWidth, pillHeight, 5)
        .fill(badgeBg);

      doc.fillColor('#ffffff')
        .fontSize(8.5)
        .font('Helvetica-Bold')
        .text(badgeText, pillX, pillY + 5, {
          width: pillWidth,
          align: 'center'
        });
    }
  }

  /**
   * Render Bottom Right Page Footer
   */
  renderFooter(doc, text) {
    doc.fontSize(7.5)
      .font('Helvetica')
      .fillColor(THEME.footerText)
      .text(text, 60, 480, {
        width: 888,
        align: 'right'
      });
  }

  /**
   * Render X-Axis Time Ticks and Centered Label
   */
  renderXAxis(doc, box, minTime, maxTime) {
    const tickCount = 8;
    const timeSpan = maxTime - minTime;
    const step = timeSpan / (tickCount - 1);

    for (let i = 0; i < tickCount; i++) {
      const curTime = minTime + i * step;
      const x = box.x + (i / (tickCount - 1)) * box.w;

      // Vertical tick mark
      doc.moveTo(x, box.y + box.h)
        .lineTo(x, box.y + box.h + 4)
        .lineWidth(0.75)
        .strokeColor(THEME.border)
        .stroke();

      // Angled time label (-40 deg)
      const timeStr = formatTimeUtc8(curTime);
      doc.save();
      doc.translate(x, box.y + box.h + 6);
      doc.rotate(-40);
      doc.fontSize(8.5)
        .font('Helvetica')
        .fillColor(THEME.axisText)
        .text(timeStr, -22, 0, { align: 'right' });
      doc.restore();
    }

    // Centered X axis label
    doc.fontSize(9)
      .font('Helvetica')
      .fillColor(THEME.axisLabel)
      .text('Time (HH:MM) UTC+8', box.x, box.y + box.h + 26, {
        width: box.w,
        align: 'center'
      });
  }

  /**
   * Single Y-Axis Line Chart (Page 1 & 3)
   */
  renderSingleAxisChart(doc, {
    box,
    minTime,
    maxTime,
    data = [],
    yMin = 0,
    yMax = 1.0,
    yTicks = 5,
    yLabel,
    lineColor,
    decimals = 1,
    emptyMessage = null
  }) {
    // 1. Chart Frame & Grid Lines
    doc.rect(box.x, box.y, box.w, box.h)
      .lineWidth(0.75)
      .strokeColor(THEME.border)
      .stroke();

    // Horizontal Grid & Y Ticks
    const yStep = (yMax - yMin) / yTicks;
    for (let i = 0; i <= yTicks; i++) {
      const val = yMin + i * yStep;
      const y = box.y + box.h - (i / yTicks) * box.h;

      // Grid line
      if (i > 0 && i < yTicks) {
        doc.moveTo(box.x, y)
          .lineTo(box.x + box.w, y)
          .lineWidth(0.5)
          .strokeColor(THEME.grid)
          .stroke();
      }

      // Tick mark
      doc.moveTo(box.x - 4, y)
        .lineTo(box.x, y)
        .lineWidth(0.75)
        .strokeColor(THEME.border)
        .stroke();

      // Tick label
      const valStr = decimals === 0 ? String(Math.round(val)) : val.toFixed(decimals);
      doc.fontSize(8.5)
        .font('Helvetica')
        .fillColor(THEME.axisText)
        .text(valStr, box.x - 36, y - 4, {
          width: 30,
          align: 'right'
        });
    }

    // Y Axis Label (rotated 90 deg counter-clockwise)
    if (yLabel) {
      doc.save();
      doc.translate(box.x - 40, box.y + box.h / 2);
      doc.rotate(-90);
      doc.fontSize(9.5)
        .font('Helvetica')
        .fillColor(THEME.axisLabel)
        .text(yLabel, -80, 0, { width: 160, align: 'center' });
      doc.restore();
    }

    // 2. X Axis
    this.renderXAxis(doc, box, minTime, maxTime);

    // 3. Render Data Line or Empty State
    if (!data || data.length === 0) {
      if (emptyMessage) {
        doc.fontSize(12)
          .font('Helvetica')
          .fillColor(THEME.footerText)
          .text(emptyMessage, box.x, box.y + box.h / 2 - 8, {
            width: box.w,
            align: 'center'
          });
      }
      return;
    }

    // Clip to chart bounds so no line spills over
    doc.save();
    doc.rect(box.x, box.y, box.w, box.h).clip();

    const timeSpan = maxTime - minTime || 1;
    const ySpan = yMax - yMin || 1;

    doc.lineWidth(1.15).strokeColor(lineColor);

    let started = false;
    for (let i = 0; i < data.length; i++) {
      const p = data[i];
      const px = box.x + ((p.time - minTime) / timeSpan) * box.w;
      const clampedVal = Math.min(yMax, Math.max(yMin, p.value));
      const py = box.y + box.h - ((clampedVal - yMin) / ySpan) * box.h;

      if (!started) {
        doc.moveTo(px, py);
        started = true;
      } else {
        doc.lineTo(px, py);
      }
    }
    doc.stroke();
    doc.restore();
  }

  /**
   * Dual Y-Axis Line Chart (Page 2: Temp & Humidity)
   */
  renderDualAxisChart(doc, {
    box,
    minTime,
    maxTime,
    leftData = [],
    leftLabel,
    leftColor,
    leftYMin = 0,
    leftYMax = 40,
    rightData = [],
    rightLabel,
    rightColor,
    rightYMin = 0,
    rightYMax = 20
  }) {
    // 1. Chart Frame
    doc.rect(box.x, box.y, box.w, box.h)
      .lineWidth(0.75)
      .strokeColor(THEME.border)
      .stroke();

    const ticks = 4;

    // Left Y Axis (Temperature)
    const leftStep = (leftYMax - leftYMin) / ticks;
    for (let i = 0; i <= ticks; i++) {
      const val = leftYMin + i * leftStep;
      const y = box.y + box.h - (i / ticks) * box.h;

      // Horizontal grid
      if (i > 0 && i < ticks) {
        doc.moveTo(box.x, y)
          .lineTo(box.x + box.w, y)
          .lineWidth(0.5)
          .strokeColor(THEME.grid)
          .stroke();
      }

      // Left tick mark & label
      doc.moveTo(box.x - 4, y).lineTo(box.x, y).lineWidth(0.75).strokeColor(THEME.border).stroke();
      doc.fontSize(8.5).font('Helvetica').fillColor(THEME.axisText).text(String(Math.round(val)), box.x - 28, y - 4, {
        width: 22,
        align: 'right'
      });
    }

    // Left Y Label
    doc.save();
    doc.translate(box.x - 38, box.y + box.h / 2);
    doc.rotate(-90);
    doc.fontSize(9.5).font('Helvetica').fillColor(THEME.tempText).text(leftLabel, -80, 0, { width: 160, align: 'center' });
    doc.restore();

    // Right Y Axis (Humidity)
    const rightStep = (rightYMax - rightYMin) / ticks;
    for (let i = 0; i <= ticks; i++) {
      const val = rightYMin + i * rightStep;
      const y = box.y + box.h - (i / ticks) * box.h;

      // Right tick mark & label
      doc.moveTo(box.x + box.w, y).lineTo(box.x + box.w + 4, y).lineWidth(0.75).strokeColor(THEME.border).stroke();
      doc.fontSize(8.5).font('Helvetica').fillColor(THEME.axisText).text(String(Math.round(val)), box.x + box.w + 6, y - 4, {
        width: 22,
        align: 'left'
      });
    }

    // Right Y Label
    doc.save();
    doc.translate(box.x + box.w + 38, box.y + box.h / 2);
    doc.rotate(90);
    doc.fontSize(9.5).font('Helvetica').fillColor(THEME.humText).text(rightLabel, -80, 0, { width: 160, align: 'center' });
    doc.restore();

    // 2. Legend inside top right
    const legendX = box.x + box.w - 180;
    const legendY = box.y - 18;

    // Temperature legend swatch
    doc.moveTo(legendX, legendY + 5).lineTo(legendX + 18, legendY + 5).lineWidth(1.75).strokeColor(leftColor).stroke();
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(THEME.titleText).text('Temperature (°C)', legendX + 22, legendY);

    // Humidity legend swatch
    const legend2X = legendX + 96;
    doc.moveTo(legend2X, legendY + 5).lineTo(legend2X + 18, legendY + 5).lineWidth(1.75).strokeColor(rightColor).stroke();
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(THEME.titleText).text('Humidity (%RH)', legend2X + 22, legendY);

    // 3. X Axis
    this.renderXAxis(doc, box, minTime, maxTime);

    // 4. Render Lines (Clipped)
    const timeSpan = maxTime - minTime || 1;

    doc.save();
    doc.rect(box.x, box.y, box.w, box.h).clip();

    // Plot Left Line (Temperature)
    if (leftData && leftData.length > 0) {
      doc.lineWidth(1.15).strokeColor(leftColor);
      let started = false;
      const leftYSpan = leftYMax - leftYMin || 1;
      for (let i = 0; i < leftData.length; i++) {
        const p = leftData[i];
        const px = box.x + ((p.time - minTime) / timeSpan) * box.w;
        const clampedVal = Math.min(leftYMax, Math.max(leftYMin, p.value));
        const py = box.y + box.h - ((clampedVal - leftYMin) / leftYSpan) * box.h;

        if (!started) {
          doc.moveTo(px, py);
          started = true;
        } else {
          doc.lineTo(px, py);
        }
      }
      doc.stroke();
    }

    // Plot Right Line (Humidity)
    if (rightData && rightData.length > 0) {
      doc.lineWidth(1.15).strokeColor(rightColor);
      let started = false;
      const rightYSpan = rightYMax - rightYMin || 1;
      for (let i = 0; i < rightData.length; i++) {
        const p = rightData[i];
        const px = box.x + ((p.time - minTime) / timeSpan) * box.w;
        const clampedVal = Math.min(rightYMax, Math.max(rightYMin, p.value));
        const py = box.y + box.h - ((clampedVal - rightYMin) / rightYSpan) * box.h;

        if (!started) {
          doc.moveTo(px, py);
          started = true;
        } else {
          doc.lineTo(px, py);
        }
      }
      doc.stroke();
    }

    doc.restore();
  }
}

module.exports = {
  PodChartPdfService,
  podChartPdfService: new PodChartPdfService(),
  parseInfluxCsvForReport
};
