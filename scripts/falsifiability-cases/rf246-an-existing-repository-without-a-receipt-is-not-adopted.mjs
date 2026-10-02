/**
 * #246 — Without it a repository someone else holds under the planned name is adopted and written to. The mutant adopts it outright rather than deleting the refusal, which would leave nothing for TypeScript to narrow.
 */
const rf246AnExistingRepositoryWithoutAReceiptIsNotAdopted = {
  id: "rf246-an-existing-repository-without-a-receipt-is-not-adopted",
  what: "a same-named repository this bootstrap operation has no record of is a wrong target, never adopted",
  file: "src/bootstrap/repo-factory-github.ts",
  find: "      if (pendingWrite === undefined) {\n        return stop(\n          ReasonCode.RESOURCE_COLLISION,\n          \"WRONG_TARGET\",\n          `${target.owner}/${target.name} already exists and carries no receipt from this bootstrap operation; it is not adopted, overwritten or renamed`,\n          id,\n          { observedNodeId: observed.value.nodeId, observed: readbackOf(observed.value) },\n          false,\n        );\n      }\n",
  replace: "      if (pendingWrite === undefined) {\n        return allow(ReasonCode.OK, {\n          receipt: {\n            operationId: id,\n            resourceType: \"repository\",\n            resourceIdentity: operation.resourceIdentity,\n            repositoryNodeId: observed.value.nodeId,\n            preexisting: false,\n            beforeStateDigest: null,\n            observed: readbackOf(observed.value),\n            createdAt: clock.nowIso(),\n            rereadAt: clock.nowIso(),\n          },\n          outcome: \"adopted\",\n        });\n      }\n",
  killedBy: ["tests/unit/repo-factory-github-producer.test.ts"],
};

export default rf246AnExistingRepositoryWithoutAReceiptIsNotAdopted;
