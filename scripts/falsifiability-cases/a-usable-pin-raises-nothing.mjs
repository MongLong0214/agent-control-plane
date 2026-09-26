/**
 * #954, from the other side. A readback that reports every pin is worth no more than one that
 * reports none: it would raise an ERROR for all three CLI adapters on every boot and on every
 * `doctor --scope capacity`, and an operator who learns to scroll past a finding has lost the
 * finding. The check has to be silent on a pin that can be spawned.
 *
 * The mutation keeps the `accessSync` probe — so the imports stay used and the mutant compiles —
 * and moves the assignment out from under it, which is the shape this mistake actually takes: a
 * condition computed unconditionally instead of from the failure it is supposed to describe. Every
 * other row in this directory drives a *broken* pin and would pass over the mutant unchanged; only
 * the control notices, which is why the control needs a row of its own.
 */
const aUsablePinRaisesNothing = {
  id: "a-usable-pin-raises-nothing",
  what: "a pin that exists, is a regular file and is executable produces no finding at all",
  file: "src/doctor/doctor.ts",
  find: '    } catch {\n      return { condition: "NOT_EXECUTABLE" };\n    }\n    return null;',
  replace: '    } catch { /* the mutation moves the verdict out from under the probe */ }\n    return { condition: "NOT_EXECUTABLE" };',
  killedBy: [
    "tests/unit/the-doctor-reads-the-pin-it-will-spawn.test.ts::says nothing about a usable pin, and nothing about an adapter that has none",
  ],
};

export default aUsablePinRaisesNothing;
