import { customType } from 'drizzle-orm/pg-core';

/**
 * Column types drizzle-orm/pg-core has no built-in for yet (spec §6.2 uses
 * `tsvector`, `citext`, `bytea` and `inet`). `dataType` only feeds the DDL
 * generator; reads/writes use the mapped TS type.
 */

export const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const citext = customType<{ data: string }>({ dataType: () => 'citext' });

export const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const inet = customType<{ data: string }>({ dataType: () => 'inet' });
