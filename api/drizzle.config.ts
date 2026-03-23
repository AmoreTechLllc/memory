import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle',
  schema: ['./src/db/schema.ts', './src/db/atBridgeSchema.ts'],
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DB_URL || 'postgres://postgres:postgres@pg:5432/postgres'
  }
})
