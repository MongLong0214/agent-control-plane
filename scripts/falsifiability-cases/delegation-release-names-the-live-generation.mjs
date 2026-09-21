const delegationReleaseNamesTheLiveGeneration = {
  "id": "delegation-release-names-the-live-generation",
  "what": "a release whose expectedBindingGeneration is the live one permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "current.bindingGeneration !== request.expectedBindingGeneration",
  "replace": "current.bindingGeneration === request.expectedBindingGeneration",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::releases the binding it names"
  ]
};

export default delegationReleaseNamesTheLiveGeneration;
