/**
 * Redux as a supervisor.
 * 
 * In this experiment React components that use machines
 * register their machine with a Redux store using a hook that
 * wraps around _useMachine_
 * 
 * _useEffect_ is used to register the machine and it's initial state
 * with the store.
 * 
 * Events sent to the machine are also intercepted and sent to the Redux store
 * functioning as an event bus instead.
 * 
 * The store reducer passes the message to the service and optionally other
 * services as well.
 * 
 * In this example an [[Input]] component controlled by a [[inputMachine]]
 * accepts additional events to be dispatched with it's `onChange` event.
 * This allows the input control for Country to send events to the machine's for
 * Province and City as well and intruct them to clear their value.
 * 
 */
import * as React from "react";
import { createStore, Store, applyMiddleware } from "redux";
import { Provider, useSelector } from "react-redux";

import * as X from "xstate";
import { useMachine } from "@xstate/react";

import createInputMachine from "./inputMachine";
import createToggleMachine from "./toggleMachine";

import logger from "redux-logger";

// Types
type AnyService = X.Interpreter<any, any, any>;
type AnyMachine = X.StateMachine<any, any, any>;

type SupervisedEvent<TEvent extends X.EventObject> =
  | TEvent & { to?: string | string[] }
  | TEvent["type"]
  | (TEvent & { to?: string | string[] } | TEvent["type"])[]
  | X.SCXML.Event<TEvent> & { to?: string | string[] };

type AnySupervisedEvent = SupervisedEvent<X.AnyEventObject>

type AnyDispatchedEvent = Exclude<X.AnyEventObject, string> & { to: string | string[] }

type DispatchedSupervisedEvent =
  | { type: "BATCHED", events: AnyDispatchedEvent[] }
  | { type: "REGISTER_MACHINE", payload: Station }
  | AnyDispatchedEvent
  
/**
 * A station is a machine attached to the event bus.
 */
type Station = {
  /** Unique identifier of the machine. Must be unique for the whole app. */
  id: string;
  /** A state machine. */
  machine: AnyMachine;
  /** A state machine interpreted. Only available if the component needing it is live. */
  service?: AnyService;
  /** If a machine is not live but components are sending events to it it will be parked here.. */
  eventQueue: AnyDispatchedEvent[];
  /** The most recent state of a machine live or not. */
  state: X.State<any, any, any, any>;
};

/**
 * Map of machine id's to [[Station]]. This is the Redux store state object
 */
type Stations = Record<string, Station>;


const isBatchedEvent = (event: DispatchedSupervisedEvent): event is { type: "BATCHED", events: AnyDispatchedEvent[] } => event.type === "BATCHED"

const isRegisterEvent = (event: DispatchedSupervisedEvent): event is { type: "REGISTER_MACHINE", payload: Station } => event.type === "REGISTER_MACHINE"

/**
 * The only type of reducer you'll see here.
 * 
 * @param state A station
 * @param event An event targetting this station.
 */
const stationReducer = (state: Station, event: AnyDispatchedEvent): Station => {
  if (state.service) {
    // If the station's service is live, fire away and compute it's next state.
    const next = state.service.send(event);

    // Only mutate store state if changes have happened.
    if (next.changed) {
      return {
        ...state,
        state: next
      };
    }

    return state;
  } else {
    // Queue the event. Event will be dispatched as soon as the machine is live.
    return {
      ...state,
      eventQueue: [...state.eventQueue, event]
    };
  }
};

/**
 * Special events are:
 * 
 * `.type: "BATCHED"` - Handles batched event just like service.send;
 * `.type: "REGISTER_MACHINE" - Introduces a new machine to the bus;
 * 
 * For all other events, if a `.to` property is present targetting a specific
 * machine then the event is only sent to that machine.
 * 
 * ToDo: Could be an array of machine id's or an asterisl to target all.
 * 
 * The Redux store reducer.
 * @param state A map of stations
 * @param event Any event.
 */
const stationsReducer = (
  state: Stations = {},
  event: DispatchedSupervisedEvent
): Stations => {
  if (isBatchedEvent(event)) {
    return event.events.reduce((acc, next) => {
      return stationsReducer(acc, next);
    }, state);
  } else if (isRegisterEvent(event)) {
    return {
      ...state,
      [event.payload.id]: event.payload
    };
  } else if (Array.isArray(event.to)) {
    const events = event.to.map(id => {
      return {
        ...event,
        to: id,
      }
    })

    return stationsReducer(state, { type: "BATCHED", events })
  }
  
  const station = state[event.to];

  if (station) {
    return {
      ...state,
      [event.to]: stationReducer(state[event.to], event)
    };
  }

  return state;
};

/**
 * The bus where all stations are connected.
 */
const store: Store<Stations, any> = createStore(
  stationsReducer,
  applyMiddleware(logger)
);

const dispatch = (event: DispatchedSupervisedEvent) => store.dispatch(event)

/**
 * Wrapper around _useMachine_
 * 
 * Machines are registered with the [[store]]. Events
 * are sent to the store rather than the _send_ function
 * returned by _useMachine_.
 * 
 * @param machine
 */
const useSupervisedMachine = <
  TContext,
  TEvent extends X.EventObject = X.AnyEventObject,
  TTypestate extends X.Typestate<TContext> = any
>(
  machine: X.StateMachine<TContext, any, TEvent, TTypestate>
) => {
  // Unique identifier
  const id = machine.id;

  let isNew = false;
  let maybeStation = store.getState()[id];

  if (!maybeStation) {
    isNew = true;

    maybeStation = {
      id: id,
      machine,
      eventQueue: [],
      state: machine.initialState
    };
  }

  // Effect with no dependencies. Actual effect is only
  // run once and registers the machine with the store.
  React.useEffect(() => {
    if (isNew) {
      dispatch({
        type: "REGISTER_MACHINE",
        // @ts-ignore
        payload: maybeStation
      });
    }
  });


  const [state, , service] = useMachine(machine, { state: maybeStation.state} );

  // Mutate the service property on the machine's related [[Station]]
  React.useEffect(() => {
    store.getState()[id].service = service;

    return () => {
      store.getState()[id].service = undefined;
    };
  }, [service, id]);

  // Our verison of service.send
  const sendWrapper = React.useMemo(() => {
    const sendToStore = (
      event: SupervisedEvent<TEvent>,
      payload?: X.EventData | undefined
    ): void => {
      // `.to` is added too all events and populated
      // with the machine's id if not present.
      if (Array.isArray(event)) {
        // Redux doesn't like array's of events so this will do:

        const events: AnyDispatchedEvent[] = event.map(batchedEvent => {
          const dispatchableEvent: AnyDispatchedEvent = typeof batchedEvent === 'string' ? {
            type: batchedEvent,
            to: id
          } : {
            ...batchedEvent,
            type: batchedEvent.type,
            to: batchedEvent.to || id
          }

          return dispatchableEvent
        })

        const batchedEvent = {
          type: "BATCHED" as const,
          events,
        }

        dispatch(batchedEvent as any);

        return;
      }

      // If not batched than just a single plain event.
      const dispatchableEvent: AnyDispatchedEvent = typeof event === 'string' ? {
        type: event,
        to: id
      } : {
        ...event,
        type: event.type,
        to: event.to || id
      }
      
      dispatch(dispatchableEvent);
    };

    return sendToStore;
  }, [id]);


  React.useEffect(
    () => {
      if (maybeStation.eventQueue.length > 0) {
        const queue = maybeStation.eventQueue.splice(0, maybeStation.eventQueue.length)
        dispatch({ type: 'BATCHED', events: queue})
      }
    }
  )

  // Voila:
  return [state, sendWrapper, service] as const;
};

/* _______________________ */

/**
 * Props for the [[Input]] component.
 */
interface PropsInput {
  /**
   * Unique id, used to create a unique machine/station as well.
   */
  id: string;
  /**
   * Send additional events when the input's value changes.
   */
  onChange?: (value: string) => X.AnyEventObject | X.AnyEventObject[];
}

/**
 * An input component using the [[inputMachine]]
 * 
 */
const Input = ({ id, onChange }: PropsInput) => {
  // Create a machine given the id
  const machine = React.useMemo(
    () =>
      createInputMachine({
        id,
        isValid: (str?: string) => !!str && !!str.trim()
      }),
    [id]
  );

  // Use the machine
  const [state, send] = useSupervisedMachine(machine);

  return (
    <>
      <label
        style={{ width: 100, display: "inline-block", fontWeight: "bold" }}
        htmlFor={`input-${id}`}
      >
        {id}:{" "}
      </label>
      <input
        style={{
          borderColor:
            state.matches("touched.touched") && state.matches("valid.invalid")
              ? "Red"
              : state.matches("touched.touched")
              ? "Green"
              : "Blue"
        }}
        id={`x-input-${id}`}
        name={`x-input-${id}`}
        value={state.context.value || ""}
        autoComplete="none"
        onChange={e => {
          if (onChange) {
            const additionalEvents: any = onChange(e.currentTarget.value);

            send([{ type: "CHANGE", value: e.currentTarget.value }].concat(
              additionalEvents
            ) as any);
            return;
          }

          send({ type: "CHANGE", value: e.currentTarget.value });
        }}
        onFocus={() => send("FOCUS")}
        onBlur={() => send("BLUR")}
      />
    </>
  );
};

/**
 * countrySelector - Example to be used with react-redux' _useSelector_
 * 
  */
const countrySelector = (storeState: Stations) =>
  storeState.Country?.state?.context?.value || '';

const Country = () => {
  const country = useSelector(countrySelector);

  return <span>{country}</span>;
};


const provinceOrStateM = createToggleMachine("provinceOrState")
/**
 * If the user changes the Country then it should clear Province, State, and City;
 * If the user changes the Province or State then it shoul clear the City;
 */
export default () => {
  const [stateNotProvince, sendStateNotProvince] = useSupervisedMachine(
    provinceOrStateM
  );

  return (
    <Provider store={store}>
      <form autoComplete="off">
      <Input
        id="Country"
        onChange={() => [
          {
            type: "CHANGE",
            value: "",
            to: ["State", "Province", "City"]
          }
        ]}
      />
      <br />
      <br />
      <Input
        id={stateNotProvince.matches("YES") ? "State" : "Province"}
        key={stateNotProvince.matches("YES") ? "State" : "Province"}
        onChange={() => [{ type: "CHANGE", value: "", to: "City" }]}
      />
      <br />
      <input
        id="stateNotProvince"
        type="checkbox"
        checked={stateNotProvince.matches("YES")}
        onChange={() => sendStateNotProvince("TOGGLE")}
      />
      <label htmlFor="stateNotProvince">I live in the USA</label>      
      <br />
      <br />
      <Input id="City" />
      <br />
      <br />
      <hr />
      <br />
      The country you entered is: <Country />
      </form>
    </Provider>
  );
};

console.clear();