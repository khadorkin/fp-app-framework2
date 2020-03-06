import { E, TE, Result } from "@fp-app/fp-ts-extensions"

import Event from "../../event"
import { getLogger } from "../../utils"

const logger = getLogger("publish")

const publish = (
  getMany: <TInput extends Event>(
    evt: TInput,
  ) => TE.PipeFunction<TInput, DomainEventReturnType, Error>[],
): publishType => async <TInput extends Event>(evt: TInput) => {
  const hndl = getMany(evt)
  logger.log(
    `Publishing Domain event: ${evt.constructor.name} (${
      hndl ? hndl.length : 0
    } handlers)`,
    JSON.stringify(evt),
  )

  if (!hndl) {
    return E.success()
  }

  for (const evtHandler of hndl) {
    logger.log(`Handling ${evtHandler.name}`)
    const r = await evtHandler(evt)()
    if (E.isErr(r)) {
      return E.err(r.left)
    }
  }

  logger.log(`Published event: ${evt.constructor.name}`)
  return E.success()
}

export default publish

// tslint:disable-next-line:max-line-length
export type publishType = <TInput extends Event>(
  evt: TInput,
) => Promise<Result<void, Error>>

export type DomainEventReturnType = void | IntegrationEventReturnType
export interface IntegrationEventReturnType {
  consistency?: "eventual" | "strict"
  handler: TE.PipeFunctionN<void, Error>
}
