// tslint:disable:max-classes-per-file
import { Lens } from "monocle-ts"

import {
  ForbiddenError,
  InvalidStateError,
  ValidationError,
  utils,
} from "@fp-app/framework"
import {
  Result,
  E,
  pipe,
  t,
  decodeErrors,
  convertCoolLens,
  Do,
} from "@fp-app/fp-ts-extensions"
import isEqual from "lodash/fp/isEqual"
import FutureDate from "./FutureDate"
import PaxDefinition from "./PaxDefinition"
import TravelClassDefinition from "./TravelClassDefinition"
import Trip, { TravelClass, TripWithSelectedTravelClass } from "./Trip"
import { merge } from "lodash"
import { flow, tuple } from "fp-ts/lib/function"
import {
  err,
  unsafeUnwrap,
  ok,
  success,
  mapLeft,
} from "@fp-app/fp-ts-extensions/src/Either"
import { T } from "@e/meffect"

import * as API from "@e/TrainTrip/infrastructure/api"

interface TrainTrip {
  readonly opportunityId?: string
  readonly lockedAt?: Date

  readonly id: string
  readonly pax: PaxDefinition
  readonly startDate: Date
  readonly travelClassConfiguration: TravelClassConfiguration[]
  readonly currentTravelClassConfiguration: TravelClassConfiguration
  readonly createdAt: Date
}

const create = (
  trip: TripWithSelectedTravelClass,
  { pax, startDate }: { startDate: FutureDate; pax: PaxDefinition },
  currentDate: Date,
): readonly [TrainTrip, readonly [TrainTripCreated]] => {
  const travelClassConfiguration = trip.travelClasses.map((x) =>
    unsafeUnwrap(TravelClassConfiguration.create(x)),
  )
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const currentTravelClassConfiguration = travelClassConfiguration.find(
    (x) => x.travelClass.name === trip.currentTravelClass.name,
  )!

  const t: TrainTrip = {
    id: utils.generateUuid(),
    pax,
    startDate,
    travelClassConfiguration,
    currentTravelClassConfiguration,
    createdAt: currentDate,
  }
  const events = tuple(TrainTripCreated.create(t.id))

  return tuple(t, events)
}

const changePax = (pax: PaxDefinition) => <This extends Pick<TrainTrip, "pax" | "id">>(
  tt: This,
) =>
  Do(E.either)
    .do(confirmUserChangeAllowed(tt))
    .let("result", pipe(tt, intChangePax(pax)))
    .return(({ result: [tt, events, changed] }) =>
      tuple(tt, [...events, ...createChangeEvents(changed)(tt)] as const),
    )

const changeStartDate = (startDate: FutureDate) => <
  This extends Pick<TrainTrip, "startDate" | "id">
>(
  tt: This,
) =>
  Do(E.either)
    .do(confirmUserChangeAllowed(tt))
    .let("result", pipe(tt, intChangeStartDate(startDate)))
    .return(({ result: [tt, events, changed] }) =>
      tuple(tt, [...events, ...createChangeEvents(changed)(tt)] as const),
    )

const changeTravelClass = (travelClass: TravelClassDefinition) => (tt: TrainTrip) =>
  Do(E.either)
    .do(
      pipe(
        tt,
        confirmUserChangeAllowed,
        E.liftErr<ForbiddenError | InvalidStateError>(),
      ),
    )
    .bind("result", pipe(tt, intChangeTravelClass(travelClass)))
    .return(({ result: [tt, events, changed] }) =>
      tuple(tt, [...events, ...createChangeEvents(changed)(tt)] as const),
    )

const opportunityIdL = Lens.fromPath<TrainTrip>()(["opportunityId"])
const assignOpportunity = (opportunityId: string) => (tt: TrainTrip) => {
  tt = opportunityIdL.modify(() => opportunityId)(tt)
  return tuple(tt, [] as const)
}

const del = (tt: TrainTrip) => tuple(TrainTripDeleted.create(tt.id))

const travelClassL = Lens.fromPath<TravelClassConfiguration>()(["travelClass"])
const travelClassConfigurationL = Lens.fromPath<TrainTrip>()([
  "travelClassConfiguration",
])

const currentTravelClassConfigurationL = Lens.fromPath<TrainTrip>()([
  "currentTravelClassConfiguration",
])

const updateTrip = (trip: Trip) => (tt: TrainTrip) => {
  // This will clear all configurations upon trip update
  // TODO: Investigate a resolution mechanism to update existing configurations, depends on business case ;-)
  tt = travelClassConfigurationL.modify(() =>
    trip.travelClasses.map((x) => {
      const existing = tt.travelClassConfiguration.find(
        (y) => y.travelClass.name === x.name,
      )
      return existing
        ? travelClassL.modify(() => x)(existing)
        : unsafeUnwrap(TravelClassConfiguration.create(x))
    }),
  )(tt)
  // unsafeUnwrap(TravelClassConfiguration.create(x)
  // vs:
  // w.travelClassConfiguration = trip.travelClasses.map(x =>
  //   const existing = this.travelClassConfiguration.find(y => y.travelClass.name === x.name)
  //   return { ...existing, travelClass: x }
  // }
  const currentTravelClassConfiguration = tt.travelClassConfiguration.find(
    (x) => tt.currentTravelClassConfiguration.travelClass.name === x.travelClass.name,
  )
  // TODO: use NonEmptyArray?
  tt = currentTravelClassConfigurationL.modify(
    () => currentTravelClassConfiguration || tt.travelClassConfiguration[0],
  )(tt)

  return tuple(tt, [] as const)
}

type ApplyChangesError = ValidationError | InvalidStateError
const updateTemplate = (tt: TrainTrip) =>
  Do(T.effect)
    .bind("trip", API.get(tt.currentTravelClassConfiguration.travelClass.templateId))
    .bindL("result2", ({ trip }) => T.sync(() => TrainTrip.updateTrip(trip)(tt)))
    .return(({ result2 }) => result2)

/*
  This might seem like a fair choice. Things just got a lot more clear,
  when we propose changes, we will also require to update templates - if change have occurred.
  The crux is in:
  - We now have to maintain this behavior for each involved method 
    - proposeChanges
    - change* functions.
  - The real issue starts happening once you have nested objects that require such behaviors
    the dependencies will ripple through all callsites.
    HOWEVER - THAT IS WHERE M-EFFECT is so strong - the dependencies are still pushed all the way outward!
    without call sites having to pass down the dependencies manual. Which is exactly one of the things domain events try to resolve..
    .. WOW. actually ;-)
  - Unit testing is more involving. Instead of strapping a basic environment,
    you must strap a more complex environment or mock more.
*/
const proposeChangesE = (state: StateProposition) => (tt: TrainTrip) =>
  Do(T.effect)
    .bind(
      "result",
      T.suspended(() => T.fromEither(proposeChanges(state)(tt))),
    )
    .bindL("result2", ({ result: [tt, , changed] }) =>
      changed ? updateTemplate(tt) : T.pure(null),
    )
    .return(({ result, result2 }) =>
      result2
        ? tuple(result2[0], [...result[1], ...result2[1]])
        : tuple(result[0], result[1]),
    )

const proposeChanges = (state: StateProposition) => (tt: TrainTrip) =>
  Do(E.either)
    .do(
      pipe(
        tt,
        confirmUserChangeAllowed,
        E.liftErr<ApplyChangesError | ForbiddenError>(),
      ),
    )
    .bind("result", pipe(tt, applyDefinedChanges(state)))
    .return(({ result: [tt, events, changed] }) =>
      tuple(tt, [...events, ...createChangeEvents(changed)(tt)] as const, changed),
    )

// TODO: we can do this better somehow..
const applyDefinedChanges = ({
  locked,
  pax,
  startDate,
  travelClass,
}: StateProposition) => (tt: TrainTrip) =>
  Do(E.either)
    .bind("tt", pipe(E.right({ value: tt }), E.liftErr<ApplyChangesError>()))
    .bindL("startDate", ({ tt }) => {
      if (startDate !== undefined) {
        const [newTT, events, changed] = pipe(tt.value, intChangeStartDate(startDate))
        tt.value = newTT
        return E.right(tuple(events, changed))
      }
      return E.right(tuple([] as const, false))
    })
    .bindL("pax", ({ tt }) => {
      if (pax !== undefined) {
        const [newTT, events, changed] = pipe(tt.value, intChangePax(pax))
        tt.value = newTT
        return E.right(tuple(events, changed))
      }
      return E.right(tuple([] as const, false))
    })
    .bindL("travelClass", ({ tt }) => {
      if (travelClass !== undefined) {
        return Do(E.either)
          .bind("r", pipe(tt.value, intChangeTravelClass(travelClass)))
          .return(({ r }) => {
            const [newTT, events, changed] = r
            tt.value = newTT
            return tuple(events, changed)
          })
      }
      return E.right(tuple([] as const, false))
    })
    .bindL("locked", ({ tt }) => {
      if (locked !== undefined) {
        if (tt.value.lockedAt && !locked) {
          return E.left(new ValidationError("Cannot unlock a locked"))
        }
        if (locked) {
          const [newTT, events, changed] = pipe(tt.value, intLock(new Date()))
          tt.value = newTT
          return E.right(tuple(events, changed))
        }
      }
      return E.right(tuple([] as const, false))
    })
    .return(({ locked, pax, startDate, travelClass, tt }) => {
      const r = tuple(
        tt.value,
        [...startDate[0], ...pax[0], ...travelClass[0], ...locked[0]] as const,
        startDate[1] || pax[1] || travelClass[1] || locked[1],
      )
      return r
    })

const lockedAtL = Lens.fromPath<TrainTrip>()(["lockedAt"])
const lock = (currentDate: Date) => (tt: TrainTrip) => {
  const [newTT, events, changed] = intLock(currentDate)(tt)
  if (changed) {
    return tuple(newTT, [...events, createChangeEvents(changed)(tt)] as const)
  }
  return tuple(tt, events)
}

const intLock = (currentDate: Date) => (tt: TrainTrip) => {
  if (tt.lockedAt) {
    return tuple(tt, noEvents(), false)
  }
  tt = lockedAtL.modify(() => currentDate)(tt)
  return tuple(tt, noEvents(), true)
}

const startDateL = convertCoolLens(
  Lens.fromPath<Pick<TrainTrip, "startDate">>()(["startDate"]),
)
const intChangeStartDate = (startDate: FutureDate) => <
  This extends Pick<TrainTrip, "startDate">
>(
  tt: This,
) => {
  if (startDate.toISOString() === tt.startDate.toISOString()) {
    return tuple(tt, noEvents(), false)
  }
  tt = startDateL.modify(() => startDate)(tt)
  return tuple(tt, noEvents(), true)
}

const noEvents = () => [] as const

const paxL = convertCoolLens(Lens.fromPath<Pick<TrainTrip, "pax">>()(["pax"]))
const intChangePax = (pax: PaxDefinition) => <This extends Pick<TrainTrip, "pax">>(
  tt: This,
) => {
  if (isEqual(tt.pax, pax)) {
    return tuple(tt, noEvents(), false)
  }
  tt = paxL.modify(() => pax)(tt)
  return tuple(tt, noEvents(), true)
}

const intChangeTravelClass = (travelClass: TravelClassDefinition) => (
  tt: TrainTrip,
) => {
  const slc = tt.travelClassConfiguration.find(
    (x) => x.travelClass.name === travelClass,
  )
  if (!slc) {
    return err(new InvalidStateError(`${travelClass} not available currently`))
  }
  if (tt.currentTravelClassConfiguration === slc) {
    return ok(tuple(tt, noEvents(), false))
  }
  tt = currentTravelClassConfigurationL.modify(() => slc)(tt)
  return ok(tuple(tt, noEvents(), true))
}

const confirmUserChangeAllowed = <This extends Pick<TrainTrip, "lockedAt" | "id">>(
  tt: This,
): Result<void, ForbiddenError> =>
  isLocked(tt)
    ? err(new ForbiddenError(`No longer allowed to change TrainTrip ${tt.id}`))
    : success()

const isLocked = <This extends Pick<TrainTrip, "lockedAt">>(tt: This) =>
  Boolean(tt.lockedAt)

const TrainTrip = {
  create,
  isLocked,
  changeStartDate,
  changePax,
  lock,
  changeTravelClass,
  proposeChanges,
  proposeChangesE,
  assignOpportunity,
  del,
  updateTrip,
}

export default TrainTrip

const createChangeEvents = (changed: boolean) => {
  return function* <This extends Pick<TrainTrip, "id">>(tt: This) {
    yield UserInputReceived.create(tt.id)
    if (changed) {
      yield TrainTripStateChanged.create(tt.id)
    }
  }
}

const Options = t.readonly(
  t.type({
    option1: t.boolean,
    option2: t.number,
  }),
)

const B = t.readonly(
  t.partial({
    priceLastUpdated: t.date,
    options: Options,
  }),
)

const Price2 = t.readonly(
  t.type({
    amount: t.number,
    currency: t.NonEmptyString,
  }),
)

const A = t.readonly(
  t.type({
    price: Price2,
    travelClass: TravelClass,
  }),
)

const _TravelClassConfiguration = t.intersection([A, B])
const createTravelClassConfiguration = (travelClass: TravelClass) => {
  return _TravelClassConfiguration.decode({
    travelClass,
    price: { amount: 1000, currency: "EUR" },
  })
}
const TravelClassConfiguration = merge(_TravelClassConfiguration, {
  create: flow(
    createTravelClassConfiguration,
    mapLeft((x) => new ValidationError(decodeErrors(x))),
  ),
})
type TravelClassConfigurationType = t.TypeOf<typeof TravelClassConfiguration>

interface TravelClassConfiguration extends TravelClassConfigurationType {}

export { TravelClassConfiguration }

/*
These event names look rather technical (like CRUD) and not very domain driven

*/

export type Events =
  | TrainTripCreated
  | TrainTripStateChanged
  | TrainTripDeleted
  | UserInputReceived

const createEvent = <TO>(t: t.TypeC<any>) => ({
  ...t,
  create: (trainTripId: string) =>
    (({
      trainTripId,
      type: t.props.type.name.substring(1, t.props.type.name.length - 1),
    } as unknown) as TO),
})

const TrainTripCreated_ = t.type({
  trainTripId: t.string,
  type: t.literal("TrainTripCreated"),
})

export const TrainTripCreated = createEvent<TrainTripCreated>(TrainTripCreated_)
export interface TrainTripCreated extends t.TypeOf<typeof TrainTripCreated_> {}

const UserInputReceived_ = t.type({
  trainTripId: t.string,
  type: t.literal("UserInputReceived"),
})
export const UserInputReceived = createEvent<UserInputReceived>(UserInputReceived_)
export interface UserInputReceived extends t.TypeOf<typeof UserInputReceived_> {}

const TrainTripStateChanged_ = t.type({
  trainTripId: t.string,
  type: t.literal("TrainTripStateChanged"),
})
export const TrainTripStateChanged = createEvent<TrainTripStateChanged>(
  TrainTripStateChanged_,
)
export interface TrainTripStateChanged
  extends t.TypeOf<typeof TrainTripStateChanged_> {}

const TrainTripDeleted_ = t.type({
  trainTripId: t.string,
  type: t.literal("TrainTripDeleted"),
})
export const TrainTripDeleted = createEvent<TrainTripDeleted>(TrainTripDeleted_)
export interface TrainTripDeleted extends t.TypeOf<typeof TrainTripDeleted_> {}

export interface StateProposition {
  locked?: boolean
  pax?: PaxDefinition
  startDate?: FutureDate
  travelClass?: TravelClassDefinition
}

export interface CreateTrainTripInfo {
  pax: PaxDefinition
  startDate: FutureDate
  templateId: string
}

export type ID = string
export type TrainTripId = ID
export type TemplateId = ID

export interface Price {
  amount: number
  currency: string
}
