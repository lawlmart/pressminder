import { parseEvent, executeEvent } from './events'
import  AWSXRay from 'aws-xray-sdk'

export default async function handler(event, context) {
  try {
    const actions = []
    for (const name in parseEvents(event)) {
      actions.push(executeEvents(name, events[name]))
    }
    await Promise.all(actions)
    context.succeed()
  } catch (err) {
    context.fail(err)
  }
}