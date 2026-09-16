/* eslint-disable */
// A real Jest test that genuinely fails with a non-zero exit code, so the
// lifecycle runner can prove teardown still happens after a failed test run.
test('intentional failure to drive post-failure teardown', () => {
  expect('actual').toBe('expected-failure');
});
