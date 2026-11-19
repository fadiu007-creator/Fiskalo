export type FiscalLedgerWriteResult = { error?: { message?: string } | null } | void;

export type FiscalSubmissionStartStep = {
  label: string;
  run: () => PromiseLike<FiscalLedgerWriteResult>;
};

/**
 * Record the audit event and submitted marker without allowing a secondary
 * ledger-write failure to suppress the one ATK request after a durable,
 * uniquely-linked fiscal document has already been created.
 *
 * Callers must still persist and surface the ATK response; this helper does
 * not retry or submit anything itself.
 */
export async function recordFiscalSubmissionStartBestEffort(
  steps: readonly FiscalSubmissionStartStep[],
  report: (message: string) => void = (message) => console.error(message),
): Promise<void> {
  for (const step of steps) {
    try {
      const result = await step.run();
      if (result && result.error) {
        report(step.label + (result.error.message ? ": " + result.error.message : ""));
      }
    } catch (error) {
      report(step.label + (error instanceof Error ? ": " + error.message : ""));
    }
  }
}
