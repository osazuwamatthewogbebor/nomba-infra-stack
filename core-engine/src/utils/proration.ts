interface CycleBounds {
  start: Date;
  end: Date;
}

/**
 * Calculates the exact remaining value of a current tier in Kobo 
 * and handles balance offsets for mid-cycle plan switches.
 */
export function calculateProratedUpgradeAmount(
  currentPlanAmountKobo: number,
  newPlanAmountKobo: number,
  cycle: CycleBounds
): { chargeAmountKobo: number; creditAppliedKobo: number } {
  const now = Date.now();
  const start = cycle.start.getTime();
  const end = cycle.end.getTime();

  if (now >= end) {
    return { chargeAmountKobo: newPlanAmountKobo, creditAppliedKobo: 0 };
  }

  const totalDuration = end - start;
  const remainingDuration = end - now;

  // Remaining asset value formula: V = Amount * (Time Remaining / Total Cycle Window)
  const remainingValueKobo = Math.round(currentPlanAmountKobo * (remainingDuration / totalDuration));
  const rawDifference = newPlanAmountKobo - remainingValueKobo;

  if (rawDifference >= 0) {
    return { chargeAmountKobo: rawDifference, creditAppliedKobo: 0 };
  } else {
    // If negative, the business owes the user a ledger credit applied to their profile
    return { chargeAmountKobo: 0, creditAppliedKobo: Math.abs(rawDifference) };
  }
}