import { effect as T } from "@matechs/effect"
import * as KOA from "@matechs/koa"
import * as O from "fp-ts/lib/Option"
// import { Do } from "fp-ts-contrib/lib/Do"
import { sequenceT } from "fp-ts/lib/Apply"
import { pipe } from "fp-ts/lib/pipeable"
import { Do } from "fp-ts-contrib/lib/Do"
import * as GetTrainTrip from "./usecases/GetTrainTrip"
import * as CreateTrainTrip from "./usecases/CreateTrainTrip"
import * as ChangeTrainTrip from "./usecases/ChangeTrainTrip"
import * as DeleteTrainTrip from "./usecases/DeleteTrainTrip"
import { joinData, handleErrors } from "@e/requestHelpers"
import provideRequestScoped from "./provideRequestScoped"

const getTrainTrip = KOA.route(
  "get",
  "/:trainTripId",
  pipe(
    Do(T.effect)
      .bindL("input", () =>
        KOA.accessReqM((ctx) =>
          pipe(GetTrainTrip.validatePrimitives(joinData(ctx)), T.fromEither),
        ),
      )
      .bindL("result", ({ input }) => GetTrainTrip.default(input))
      .return(({ result }) =>
        O.isSome(result)
          ? KOA.routeResponse(200, result.value)
          : KOA.routeResponse(404, null),
      ),
    handleErrors,
    provideRequestScoped,
  ),
)

const createTrainTrip = KOA.route(
  "post",
  "/",
  pipe(
    Do(T.effect)
      .bind(
        "input",
        KOA.accessReqM((ctx) =>
          pipe(CreateTrainTrip.validatePrimitives(joinData(ctx)), T.fromEither),
        ),
      )
      .bindL("result", ({ input }) => CreateTrainTrip.default(input))
      .return(({ result }) => KOA.routeResponse(200, result)),
    handleErrors,
    provideRequestScoped,
  ),
)

const changeTrainTrip = KOA.route(
  "patch",
  "/:trainTripId",
  pipe(
    Do(T.effect)
      .bind(
        "input",
        KOA.accessReqM((ctx) =>
          pipe(ChangeTrainTrip.validatePrimitives(joinData(ctx)), T.fromEither),
        ),
      )
      .bindL("result", ({ input }) => ChangeTrainTrip.default(input))
      .return(({ result }) => KOA.routeResponse(200, result)),
    handleErrors,
    provideRequestScoped,
  ),
)

const deleteTrainTrip = KOA.route(
  "delete",
  "/:trainTripId",
  pipe(
    Do(T.effect)
      .bindL("input", () =>
        KOA.accessReqM((ctx) =>
          pipe(DeleteTrainTrip.validatePrimitives(joinData(ctx)), T.fromEither),
        ),
      )
      .bindL("result", ({ input }) => DeleteTrainTrip.default(input))
      .return(({ result }) => KOA.routeResponse(200, result)),
    handleErrors,
    provideRequestScoped,
  ),
)

const routes = sequenceT(T.effect)(
  createTrainTrip,
  getTrainTrip,
  changeTrainTrip,
  deleteTrainTrip,
)

const router = pipe(routes, KOA.withSubRouter("/train-trip"))

export default router