const { PrismaClient } = require('@prisma/client');

// Global Prisma Client instance singleton
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
});

module.exports = prisma;
