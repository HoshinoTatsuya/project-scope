import type { MIGRATION_LAYOUT } from '../constants/migration-layout.constant';

export type MigrationLayout = (typeof MIGRATION_LAYOUT)[keyof typeof MIGRATION_LAYOUT];
