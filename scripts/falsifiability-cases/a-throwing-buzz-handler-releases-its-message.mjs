/**
 * R1041-04: a handler that threw is not running either; its registration ends on the way out.
 */
const aThrowingBuzzHandlerReleasesItsMessage = {
  id: "a-throwing-buzz-handler-releases-its-message",
  what: "a Buzz handler that threw is no longer registered as running",
  file: "src/ingress/buzz-message.ts",
  find: "  } catch (error) {\n    handling.end();\n    throw error;\n  }",
  replace: "  } catch (error) {\n    throw error;\n  }",
  killedBy: [
    "tests/unit/a-completed-receipt-settles-with-its-owner-reply.test.ts::R1041-04 settles a turn whose Buzz handler threw",
  ],
};

export default aThrowingBuzzHandlerReleasesItsMessage;
