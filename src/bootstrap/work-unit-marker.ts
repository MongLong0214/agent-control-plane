/**
 * #1240 — Repo Factory's work-unit marker, the one place it is read.
 *
 * A genesis issue's body ends, after a blank line, with `Work unit <k> of <n>: <key>`: the link from
 * the issue to one approved work unit, named by the request's public plan key. It links; it proves
 * nothing about the issue's content, which blind review judges. Repo Factory's unit rule may change, so
 * nothing else parses the line. STANDARD_WORK issues carry no such line: their unit links are ACP's own
 * record (`work-scope-tracking.ts`), so no internal id is published.
 */
export interface WorkUnitMarker {
  k: number;
  n: number;
  key: string;
}

const WORK_UNIT = /^Work unit ([1-9]\d*) of ([1-9]\d*): ([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** Every marker line of a body, in order, and the marker that is its last line, if one is. */
export const workUnitMarkers = (body: string | null | undefined): { markers: WorkUnitMarker[]; last: WorkUnitMarker | null } => {
  const lines = (body ?? "").trimEnd().split(/\r?\n/);
  const markers: WorkUnitMarker[] = [];
  let last: WorkUnitMarker | null = null;
  for (const [index, line] of lines.entries()) {
    const match = WORK_UNIT.exec(line);
    if (match === null) continue;
    const marker = { k: Number(match[1]), n: Number(match[2]), key: match[3]! };
    markers.push(marker);
    if (index === lines.length - 1) last = marker;
  }
  return { markers, last };
};
