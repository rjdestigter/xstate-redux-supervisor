import * as X from "xstate";

export default (id: string) =>
  X.createMachine({
    id,
    initial: "NO",
    states: {
      YES: { on: { TOGGLE: "NO" } },
      NO: { on: { TOGGLE: "YES" } }
    }
  });
