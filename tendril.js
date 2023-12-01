// @ts-check

/** 
 * @typedef {() => void} Cancel - a zero-argument function you can call to
 *   cancel subscription. Expected to be idempotent.
 */

/**
 * @template Value
 * @typedef {() => Value} Peekable - get signal's current value
 */

/**
 * @template Value
 * @typedef {(value: Value) => void} Subscriber - a callback function
 *   that takes a single argument
 */

/**
 * @template Value
 * @typedef {Object} Subscribable
 * @property {(subscriber: Subscriber<Value>) => Cancel} observe - subscribe
 *   to future values, returning a function to cancel the subscription.
 */

/**
 * @template Value
 * @typedef {Peekable<Value> & Subscribable<Value>} SignalValue - the read-only
 *   portion of a signal
 */

/**
 * Create a throttling scheduler. Scheduler can be called multiple times with
 * different thunks but will only be called once per interval.
 * You can call the scheduler with different thunks. Last thunk wins.
 * 
 * @param {(thunk: () => void) => void} schedule 
 * @returns {(thunk: () => void) => void}
 */
const createThrottlingScheduler = schedule => {
  /** @type {(() => void) | null} */
  let perform = null
  let isUpdateScheduled = false

  const performUpdate = () => {
    if (perform != null) {
      perform()
    }
    isUpdateScheduled = false
  }

  return thunk => {
    // Assign new thunk. Last thunk assigned during this tick wins.
    perform = thunk
    if (!isUpdateScheduled) {
      isUpdateScheduled = true
      schedule(performUpdate)
    }
  }
}

/**
 * Signals updates are deferred to the next microtask and batched.
 * Only the last set during a single tick will trigger an update to observers.
 * This solves the "diamond problem"
 * @template Value
 * @returns {[SignalValue<Value>, (value: Value) => void]}
 */
export const signal = initial => {
  const observers = new Set()
  const throttle = createThrottlingScheduler(queueMicrotask)
  let value = initial

  const setValue = next => {
    if (value !== next) {
      value = next
      // Batch dispatches to prevent the "diamond problem".
      // Diamond problem: if multiple upstream triggers are derived from the
      // same source, you'll get two events for every event on source.
      // Example: Signal A has two signals derived from it: B and C.
      // D samples on B and C. When A publishes, B and C both publish. D
      // receives two events, one after the other, resulting in two different
      // sample values, one after the other.
      //
      // Batching solves the problem by only dispatching once per microtask,
      // using the last dispatch.
      throttle(dispatch)
    }
  }

  const dispatch = () => {
    for (let observer of observers) {
      observer(value)
    }
  }

  const getValue = () => value

  getValue.observe = observer => {
    observer(value)
    observers.add(observer)
    return () => observers.delete(observer)
  }

  return [getValue, setValue]
}

export const useSignal = signal

/**
 * Check if thing is a signal
 * @param {*} thing 
 * @returns {Boolean}
 */
export const isSignal = thing =>
  typeof thing === 'function' && typeof thing.sub === 'function'

/**
 * Throttle a signal, returning a new signal that updates only once per
 * animation frame.
 * @template Value
 * @param {SignalValue<Value>} upstream
 * @returns {SignalValue<Value>}
 */
export const animate = upstream => {
  const throttleAnimation = createThrottlingScheduler(requestAnimationFrame)
  let [downstream, setDownstream] = signal(upstream())
  const cancel = upstream.observe(
    value => throttleAnimation(() => setDownstream(value))
  )
  setCancel(downstream, cancel)
  return downstream
}

/**
 * Create a reducer-style signal.
 * Signal may be updated by sending values to the returned setter. When you
 * set a new value, step is called with the current signal state and
 * the new value, and returns the next state.
 * @template State, Value
 * @param {(state: State, value: Value) => State} step
 * @param {State} initial
 * @returns {[SignalValue<State>, (value: Value) => void]}
 */
export const useReducer = (step, initial) => {
  const [state, setState] = useSignal(initial)
  const advanceState = value => setState(
    step(state(), value)
  )
  return [state, advanceState]
}

/**
 * The cancel symbol
 */
const __cancel__ = Symbol('cancel')

/**
 * Store cancel function on this object
 * @template Subject
 * @param {Subject} object 
 * @param {Cancel} cancel 
 * @returns {Subject}
 */
export const setCancel = (object, cancel) => {
  if (typeof cancel !== 'function') {
    throw new TypeError('cancel must be a function')
  }
  object[__cancel__] = cancel
  return object
}

/**
 * Call cancel function on this object, if it has one
 * @param {Object} cancellable 
 */
export const cancel = cancellable => {
  let cancel = cancellable[__cancel__]
  if (typeof cancel === 'function') {
    cancel()
  }
}

/**
 * Batch cancels together, returning a cancel function that runs them all.
 * Cancels are run once and then removed.
 * @param {Array<Cancel>} cancels
 * @returns {Cancel}
 */
export const batchCancels = cancels => {
  let batch = new Set(cancels)
  return () => {
    for (const cancel of batch) {
      cancel()
    }
    batch.clear()
  }
}

/**
 * Reduced is a sentinal for a completed reduction.
 * Returning reduced from a stepping function will cause `reductions` to
 * automatically cancel its upstream subscription, treating the value of
 * reduced as the final value of the reduction.
 * @template Value
 */
class Reduced {
  /**
   * Create a reduced value
   * @param {Value} value
   */
  constructor(value) {
    this.value = value
  }
}

/**
 * @template State, Value
 * @typedef {(state: State, value: Value) => (State|Reduced<State>)} Step
 *   a stepping function that can be used for `reduce()`
 */

/**
 * Create a new signal by reducing over any subscribable value
 * @template State, Value
 * @param {Step<State, Value>} step
 * @param {Subscribable<Value>} value
 * @param {State} initial
 * @returns {SignalValue<State>}
 */
export const reductions = (step, value, initial) => {
  const [state, setState] = useSignal(initial)
  const cancel = value.observe(value => {
    let next = step(state(), value)
    // If reduction sent a complete sentinal value, then cancel our subscription
    // and set the completed value as the last published state.
    if (next instanceof Reduced) {
      cancel()
      setState(next.value)
      return
    }
    setState(next)
  })
  setCancel(state, cancel)
  return state
}

/**
 * Transduers over any subscribable value.
 * Inspired by Clojure's tranducers, which implement every collection
 * manipulation function as transformations of the stepping function passed
 * to reduce.
 * Benefits:
 * - You can compose transducer functions
 * - You don't need to create intermediate collections
 * - Every collection operation becomes available if you just implement reduce.
 * @see http://blog.cognitect.com/blog/2014/8/6/transducers-are-coming
 * @see http://bendyworks.com/transducers-clojures-next-big-idea/
 * @see https://www.cs.nott.ac.uk/~pszgmh/fold.pdf
 * @template A, B, C, D
 * @param {(step: Step<C, D>) => Step<A, B>} xf
 * @param {Step<C, D>} step
 * @param {Subscribable<B>} subscribable
 * @param {A} initial
 * @returns {SignalValue<A>}
 */
export const transductions = (xf, step, subscribable, initial) =>
  reductions(xf(step), subscribable, initial)

/**
 * Create a mapping transducer function
 * @template State, Input, Output
 * @param {(input: Input) => Output} transform
 * @returns {(step: Step<State, Output>) => Step<State, Input>}
 */
export const mapping = transform => step => (state, value) =>
  step(state, transform(value))

/**
 * Create a filtering transducer function
 * @template State, Value
 * @param {(input: Value) => Boolean} predicate
 * @returns {(step: Step<State, Value>) => Step<State, Value>}
 */
export const filtering = predicate => step => (state, value) =>
  predicate(value) ? step(state, value) : state

/**
 * Create a take-while transducer function that will take values until the
 * predicate returns false.
 * @template State, Value
 * @param {(input: Value) => Boolean} predicate
 * @returns {(step: Step<State|Reduced<State>, Value>) => Step<(State|Reduced<State>), Value>}
 */
export const takingWhile = predicate => step => (state, value) =>
  predicate(value) ? step(state, value) : new Reduced(state)

/**
 * Step value forward, ignoring state
 * @template Value
 * @param {*} _
 * @param {Value} value
 * @returns {Value}
 */
const stepForward = (_, value) => value

/**
 * Map a signal, observable, or any subscribable value
 * Returns a new signal for the mapped value
 * @template State
 * @template Value
 * @param {Subscribable<Value>} upstream
 * @param {(value: Value) => State} transform
 * @returns {SignalValue<State>}
 */
export const map = (upstream, transform) => {
  let xf = mapping(transform)
  let initial = transform(upstream())
  return transductions(xf, stepForward, upstream, initial)
}

/**
 * Sample values via closure by watching a list of trigger signals.
 * @example sample the sum of x and y whenever either changes
 * let sum = sample([x, y], () => x() + y())
 * @template Value
 * @param {Array<SignalValue<Value>>} triggers
 * @param {() => Value} resample
 * @returns {SignalValue<Value>}
 */
export const sample = (triggers, resample) => {
  let [downstream, setDownstream] = useSignal(resample())

  const cancel = batchCancels(
    triggers.map(
      upstream => upstream.observe(
        () => setDownstream(resample())
      )
    )
  )

  setCancel(downstream, cancel)

  return downstream
}

/**
 * Get object id property
 */
export const getId = x => x.id

/**
 * Index an array to a `Map` by key, using `getKey`.
 * Maps retain order of insertion, making them an efficient data structure
 * for ordered items with IDs, when you're doing frequent lookups.
 * @template Key
 * @template Value
 * @param {Array<Value>} values - an array of values with a unique key
 * @param {(value: Value) => Key} getKey - a function to get a unique key from
 *   the value
 * @returns {Map<Key, Value>}
 */
export const index = (values, getKey=getId) => {
  let indexed = new Map()
  for (const value of values) {
    let key = getKey(value)
    indexed.set(key, value)
  }
  return indexed
}

/**
 * Create an index signal from an array signal.
 * Items in the array are indexed by ID, as defined by `getId`.
 * 
 * When creating a cursor into an array, it can be more efficient to first
 * create an `indexed` signal, so that cursor lookups are done by key `O(1)`
 * rather than by iterating over whole list `O(n)`.
 * 
 * @template Key
 * @template Value
 * @param {SignalValue<Array<Value>>} items
 * @param {(value: Value) => Key} getKey
 * @returns {SignalValue<Map<Key, Value>>}
 */
export const indexed = (items, getKey=getId) =>
  map(items, items => index(items, getKey))

  /**
 * @template State
 * @template Msg
 * @typedef Transaction
 * @property {State} state
 * @property {Array<(Promise<Msg>|Msg)>} effects
 */

/**
 * Create a state transaction for a store
 * @template State
 * @template Msg
 * @param {State} state 
 * @param {Array<(Msg|Promise<Msg>)>} effects 
 * @returns {Transaction<State, Msg>}
 */
export const next = (state, effects=[]) => ({state, effects})

/**
 * Create a store
 * A store is a repository of state that can be updated by sending messages.
 * Store also manages asynchronous side effects, modeled as promises for more
 * messages.
 * 
 * `init` and `update` both return transactions, an object containing a new
 * `state`, as well as an array of promises representing side-effects.
 * 
 * Store is inspired by the the Elm Architecture pattern. It offers a
 * predictable and centralized way to manage both application state and
 * side-effects such as HTTP requests and database calls.
 * 
 * @template State
 * @template Msg
 * @param {object} options
 * @param {() => Transaction<State, Msg>} options.init
 * @param {(state: State, msg: Msg) => Transaction<State, Msg>} options.update
 * @param {boolean} options.debug - toggle debug logging
 * @returns {[SignalValue<State>, (Msg) => void]} a signal value and
 *   send function.
 */
export const useStore = ({
  init,
  update,
  debug=false
}) => {
  let {state: initial, effects} = init()
  const [state, setState] = useSignal(initial)

  /**
   * @param {Promise<Msg>|Msg} effect
   */
  const run = async (effect) => send(await effect)

  /**
   * 
   * @param {Msg} msg 
   */
  const send = msg => {
    if (debug) {
      console.debug("store.msg", msg)
    }
    let {state: next, effects} = update(state(), msg)
    setState(next)
    if (debug) {
      console.debug("store.state", next)
      console.debug("store.effects", effects.length)
    }
    for (const effect of effects) {
      run(effect)
    }
  }

  return [state, send]
}

/**
 * Handle an unknown message by logging a warning and returning a transaction
 * which does not change state.
 * @template State
 * @template Msg
 * @param {State} state 
 * @param {Msg} msg 
 * @returns 
 */
export const unknown = (state, msg) => {
  console.warn('Unknown message type. Ignoring.', msg)
  return next(state)
}

/**
 * Render a dynamic list of children on a parent.
 * @template Key
 * @template State
 * @param {SignalValue<Map<Key, State>>} states - a signal for a map of
 *   children to render
 * @param {Element} parent
 * @param {(state: State) => (Element|string)} create - a function to create
 *   new children. Children are created once for each key. All updates to
 *   children happen through signals passed to child.
 * @returns {Element} - function to cancel future child renders.
 */
export const list = (parent, states, create) => {
  const cancel = states.observe(() => renderList(parent, states, create))
  setCancel(parent, cancel)
  return parent
}

const renderList = (
  parent,
  states,
  create
) => {
  // Remove children that are no longer part of state
  // Note that we must construct a list of children to remove, since
  // removing in-place would change the live node list and bork iteration.
  const childMap = new Map()
  const removes = []
  for (const child of parent.children) {
    const key = child.dataset.key
    childMap.set(key, child)
    if (!states().has(key)) {
      removes.push(child)
    }
  }

  for (const child of removes) {
    // Cancel child subscription and remove
    cancel(child)
    parent.removeChild(child)
  }

  // Add or re-order children as needed.
  let i = 0
  for (const key of states().keys()) {
    const child = childMap.get(key)
    if (child == null) {
      const state = map(states, states => states.get(key))
      const child = create(state)
      setCancel(child, () => cancel(state))
      child.dataset.key = key
      insertElementAt(parent, child, i)
    } else {
      insertElementAt(parent, child, i)
    }
    i = i + 1
  }
}

/**
 * Insert element at index.
 * If element is already at index, this function is a no-op
 * (it doesn't remove-and-then-add element). By avoiding moving the element
 * unless needed, we preserve focus and selection state for elements that
 * don't move.
 * @param {HTMLElement} parent - the parent element to insert child into
 * @param {HTMLElement} element - the child element to insert
 * @param {number} index - the index at which to insert element
 */
export const insertElementAt = (parent, element, index) => {
  let elementAtIndex = parent.children[index]
  if (elementAtIndex === element) {
    return
  }
  parent.insertBefore(element, elementAtIndex)
}

let _cid = 0

/**
 * Create an auto-incrementing client ID.
 * ID is unique for a given page refresh, but should not be persisted.
 * @returns {string} a client ID
 */
export const cid = () => `cid${_cid++}`
