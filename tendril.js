/**
 * Creates a dependency tracker
 * We use this to allow signals to automatically gather their downstream
 * dependencies.
 */
const dependencyTracker = () => {
  const scopes = []

  const getTracked = () => scopes.at(-1)

  const withTracking = (onChange, perform) => {
    scopes.push(onChange)
    const value = perform()
    scopes.pop()
    return value
  }

  return {withTracking, getTracked}
}

const {withTracking, getTracked} = dependencyTracker()

/**
 * Given a zero-argument function, create a throttled version of that function
 * that will run only once per microtask.
 * @param {() => void} job - the function to perform
 * @returns {() => void} - a throttled version of that function
 */
export const throttled = job => {
  let isScheduled = false

  const perform = () => {
    job()
    isScheduled = false
  }

  const schedule = () => {
    if (!isScheduled) {
      isScheduled = true
      queueMicrotask(perform)
    }
  }

  return schedule
}

/**
 * Create a transaction notification publisher.
 * Allows you to register listeners that are called once during the next
 * transaction.
 */
const transaction = () => {
  let transaction = new Set()

  /**
   * Add listener to current transaction.
   * Listener functions are deduped. E.g. if you add the same listener twice to
   * the same transaction, it's only added once.
   */
  const withTransaction = listener => {
    if (typeof listener === 'function') {
      transaction.add(listener)
    }
  }

  /**
   * Perform a transaction.
   * Listeners in transaction are notified once and then forgotten.
   */
  const transact = () => {
    // Capture transaction
    const listeners = transaction
    // Create a new transaction. This transaction will gather dependencies
    // queued while executing listeners.
    transaction = new Set()
    // Perform transaction.
    for (const listener of listeners) {
      listener()
    }
    // Listeners are released after scope exits so they can be garbaged.
  }

  return {withTransaction, transact}
}

/**
 * Is value a signal-like function?
 * A signal is any zero-argument function.
 */
export const isSignal = value =>
  (typeof value === 'function' && value.length === 0)

/**
 * Sample a value that may be a signal, or just an ordinary value
 */
export const sample = value => isSignal(value) ? value() : value

/**
 * A signal is a reactive state container. It holds a single value which is
 * updated atomically.
 *
 * Consumers may subscribe to signal update events with the `listen()`
 * method, or read the current value by calling it as a function.
 */
export const useSignal = initial => {
  const didChange = transaction()

  let state = initial

  /**
   * Read current signal state
   */
  const read = () => {
    didChange.withTransaction(getTracked())
    return state
  }

  /**
   * Send new value to signal
   */
  const send = value => {
    if (state !== value) {
      state = value
      didChange.transact()
    }
  }

  return [read, send]
}

export const useComputed = compute => {
  const didChange = transaction()

  // We batch recomputes to solve the diamond problem.
  // Every upstream signal read within the computed's tracking scope can
  // independently generate a change notification. This means if two upstream
  // signals change at once, our transaction callback gets called twice.
  // By scheduling batch updates on the next microtask, we ensure that the
  // computed signal is recomputed only once per event loop turn.
  const recompute = throttled(() => {
    const value = withTracking(recompute, compute)
    if (state !== value) {
      state = value
      didChange.transact()
    }
  })

  const read = () => {
    didChange.withTransaction(getTracked())
    return state
  }

  let state = withTracking(recompute, compute)

  return read
}

export const useEffect = perform => {
  const performEffect = throttled(() => {
    withTracking(performEffect, perform)
  })

  withTracking(performEffect, perform)
}

/**
 * Create store for state. A web app can centralize all state in a single store,
 * and use Signals to scope store state down to DOM updates.
 * Store is inspired by the Elm App Architecture Pattern.
 * @returns {[Signal<State>, (msg: Msg) => void]}
 */
export const useStore = ({
  init,
  update,
  debug=false
}) => {
  const initial = init()
  if (debug) {
    console.debug('useStore.state', initial.state)
    console.debug('useStore.effects', initial.effects.length)
  }

  const [state, sendState] = useSignal(initial.state)

  const send = msg => {
    const {state: next, effects} = update(state(), msg)
    if (debug) {
      console.debug('useStore.msg', msg)
      console.debug('useStore.state', next)
      console.debug('useStore.effects', effects.length)
    }
    sendState(next)
    runEffects(effects)
  }

  const runEffect = async (effect) => {
    const msg = await effect
    if (msg != null) {
      send(msg)
    }
  }

  const runEffects = effects => effects.forEach(runEffect)

  runEffects(initial.effects)

  return [state, send]
}

/**
 * Create a transaction object for the store.
 */
export const next = (state, effects=[]) => ({state, effects})

/**
 * Log an unknown message and return a no-op transaction. Useful for handling
 * the `default` arm of a switch statement in an update function to catch
 * anything sent to the store that you don't recognize.
 */
export const unknown = (state, msg) => {
  console.warn('Unknown message type', msg)
  return next(state)
}

/**
 * Transform a signal, returning a computed signal that takes values until
 * the given signal returns null. Once the given signal returns null, the
 * signal is considered to be complete and no further updates will occur.
 *
 * This utility is useful for signals representing a child in a dynamic collection
 * of children, where the child may cease to exist.
 * A computed signal looks up the child, returns null if that child no longer
 * exists. This completes the signal and breaks the connection with upstream
 * signals, allowing the child signal to be garbaged.
 */
export const takeValues = signal => {
  let state = signal()
  let isComplete = false

  return useComputed(() => {
    if (isComplete) {
      return state
    }

    const next = signal()

    if (next != null) {
      state = next
      return state
    } else {
      isComplete = true
      return state
    }
  })
}