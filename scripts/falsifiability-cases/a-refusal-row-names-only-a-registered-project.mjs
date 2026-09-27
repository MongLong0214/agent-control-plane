/**
 * The canonical self-claim's refusal row used to copy the request's `projectId` into `project_id`
 * verbatim. The operator accepts any nonempty string there, and `AuditLog.record` redacts only
 * `evidence`, so a refused claim could put a private path or a token into the durable log. The
 * refusal row now carries the project only when it names a row in `projects`, and null otherwise:
 * the registry is the existing authority for what a project id is, and no pattern is added.
 *
 * The mutation keeps the registry lookup and makes both of its answers the caller's text, so it
 * typechecks and the lookup still runs; only the bound is gone. The named verdict reads the row
 * back out of the database and requires a null project for an unregistered id carrying a path and
 * a bearer-shaped token. A registered id is unaffected by this mutant, so the verdicts that pin a
 * registered project on a refusal row are the control that the bound does not null everything.
 */
const c = {
  id: "a-refusal-row-names-only-a-registered-project",
  what: "a refused canonical self-claim records its project only when the projects registry holds it, and null otherwise",
  file: "src/registry/canonical-self-claim.ts",
  find: "    projectId: isRegisteredProject(asked.projectId) ? asked.projectId : null,",
  replace: "    projectId: isRegisteredProject(asked.projectId) ? asked.projectId : asked.projectId,",
  killedBy: [
    "tests/unit/canonical-self-claim.test.ts::a refusal naming a project the registry does not hold records a null project and keeps its reason code",
  ],
};
export default c;
