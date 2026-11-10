import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Retain identities after a score disappears so saved filters and index
// rebuilds never depend on the set of providers present in today's documents.
export const RatingField = sqliteTable('rating_field', {
  key: text().primaryKey(),
  providerId: text().notNull(),
  kind: text().notNull(),
});
