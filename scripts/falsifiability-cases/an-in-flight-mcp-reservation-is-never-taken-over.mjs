/**
 * CP-HI-06-02. Staleness is judged by the caller's timestamp, so without this check a caller could
 * call a live reservation stale and run the mutation a second time beside a handler still in flight.
 * The mutant drops the in-flight refusal; the killing test suspends the first handler and takes the
 * reservation over with a timestamp an hour ahead.
 */
const anInFlightMcpReservationIsNeverTakenOver = {
  id: "an-in-flight-mcp-reservation-is-never-taken-over",
  what: "a reservation whose handler is running in this process is never taken over, whatever time the caller claims",
  file: "src/ingress/ingress-guard.ts",
  find: "    if (existing && mcpReservationsInFlight.get(db)?.has(nonce)) {\n",
  replace: "    if (existing && mcpReservationsInFlight.get(db)?.has(`${nonce}\\u0000unmatched`)) {\n",
  killedBy: [
    "tests/unit/ops-r2.test.ts::keeps an in-flight MCP reservation sealed from raw deletes and exported release issuers",
  ],
};

export default anInFlightMcpReservationIsNeverTakenOver;
