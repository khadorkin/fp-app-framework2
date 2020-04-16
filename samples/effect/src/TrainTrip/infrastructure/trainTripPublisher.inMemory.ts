import { TrainTripId } from "@e/TrainTrip/TrainTrip"
import { utils } from "@fp-app/framework"
import { F, T } from "@e/meffect"
import executeReceived from "@e/TrainTrip/queueRouter"
import * as API from "@e/TrainTrip/infrastructure/api"
import { AsyncRT } from "@matechs/effect/lib/effect"

/**
 * Poor man's queue, great for testing. Do not use in production, or you may loose queued tasks on server restart
 */
export default class TrainTripPublisherInMemory {
  private readonly map = new Map<TrainTripId, NodeJS.Timeout>()
  private readonly logger = utils.getLogger(this.constructor.name)

  registerIfPending = (trainTripId: TrainTripId, r: RequiredDeps) => {
    if (!this.trainTripIsPending(trainTripId)) {
      return
    }
    return this.register(trainTripId, r)
  }

  register = (trainTripId: TrainTripId, r: RequiredDeps) => {
    const current = this.map.get(trainTripId)
    if (current) {
      clearTimeout(current)
    }

    this.map.set(
      trainTripId,
      setTimeout(() => {
        this.tryPublishTrainTrip(trainTripId, requestInNewScope(r))
      }, CLOUD_PUBLISH_DELAY),
    )
  }

  private tryPublishTrainTrip = async (
    trainTripId: string,
    req: <E, A>(inp: T.Effect<RequiredDeps, E, A>) => T.Effect<AsyncRT, E, A>,
  ) => {
    try {
      this.logger.log(`Publishing TrainTrip to Cloud: ${trainTripId}`)
      await T.runToPromise(
        req(executeReceived({ type: "RegisterOnCloud", trainTripId })),
      )
    } catch (err) {
      // TODO: really handle error
      this.logger.error(err)
    } finally {
      this.map.delete(trainTripId)
    }
  }

  private trainTripIsPending(trainTripID: TrainTripId) {
    return this.map.has(trainTripID)
  }
}

type RequiredDeps = AsyncRT & TrainTripPublisher & API.TripApi

// TODO: This inherits everything from the global scope
// and the current request-scope. It should be fine to pick up
// the current request-id for logging, but otherwise should be new scope
// based on global, and fully new request scope.
// this should also have "all env" as type :/

// what is missing in the global scope providing is the providing for "RegisterCloud"..
// probably should build an own total scope like we do for the Router!
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requestInNewScope = (r: RequiredDeps) => <E, A>(
  inp: T.Effect<RequiredDeps, E, A>,
) => T.provide({ ...r })(inp) as T.Effect<AsyncRT, E, A>

const CLOUD_PUBLISH_DELAY = 10 * 1000

const TrainTripPublisherURI = "@fp-app/effect/traintrip-publisher"
const TrainTripPublisher_ = F.define({
  [TrainTripPublisherURI]: {
    register: F.fn<(id: string) => T.Io<void>>(),
    registerIfPending: F.fn<(id: string) => T.Io<void>>(),
  },
})
export interface TrainTripPublisher extends F.TypeOf<typeof TrainTripPublisher_> {}

export const TrainTripPublisher = F.opaque<TrainTripPublisher>()(TrainTripPublisher_)

export const { register, registerIfPending } = F.access(TrainTripPublisher)[
  TrainTripPublisherURI
]

export const contextEnv = "@fp-app/effect/traintrip-publisher/ctx"

export interface Context {
  [contextEnv]: {
    ctx: TrainTripPublisherInMemory
  }
}

export const env = {
  [TrainTripPublisherURI]: {
    register: (id: string) =>
      // Workaround for in-process fake queue
      T.accessM((r: Context) =>
        T.pure(
          r[contextEnv].ctx.register(id, (r as unknown) as Context & RequiredDeps),
        ),
      ),
    registerIfPending: (id: string) =>
      T.accessM((r: Context) =>
        T.pure(
          // Workaround for in-process fake queue
          r[contextEnv].ctx.registerIfPending(
            id,
            (r as unknown) as Context & RequiredDeps,
          ),
        ),
      ),
  },
}
export const provideTrainTripPublisher = F.implement(TrainTripPublisher)(env)
