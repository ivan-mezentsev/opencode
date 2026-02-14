export declare namespace StatefulActor {
  export interface Stateful<S> {
    readonly get: () => S
    readonly set: (state: S) => void
    readonly update: (f: (state: S) => S) => S
  }
}

export const StatefulActor = {
  make: <S>(initial: S): StatefulActor.Stateful<S> => {
    let state = initial
    return {
      get: () => state,
      set: (next) => {
        state = next
      },
      update: (f) => {
        state = f(state)
        return state
      },
    }
  },
} as const
