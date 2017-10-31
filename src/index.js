import { parseEvents, executeEvents } from './events'
import  AWSXRay from 'aws-xray-sdk'
AWSXRay.enableManualMode()

exports.handler = async function(event, context) {
  const segment = new AWSXRay.Segment('handler');
  try {
    const actions = []
    const events = parseEvents(event)
    const names = Object.keys(events)
    for (const name of names) {
      const eventPayloads = events[name]
      console.log("Executing " + eventPayloads.length.toString() + " " + name + " events")
      actions.push(executeEvents(name, eventPayloads, segment))
    }
    await Promise.all(actions)

    console.log("Handler finished")
    segment.close();
    context.succeed();
  } catch (err) {
    console.log("Handler error: " + err)
    segment.close();
    context.fail(err)
  }
}