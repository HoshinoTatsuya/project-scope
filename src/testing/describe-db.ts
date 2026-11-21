import { PG_TEST_URL } from './pg-test-url';

/** Без адреса набор пропускается, и jest-assert-no-skipped валит прогон. */
export const describeDb = PG_TEST_URL ? describe : describe.skip;
