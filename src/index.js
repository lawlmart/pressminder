import { parseEvents, executeEvents } from './events'
import  AWSXRay from 'aws-xray-sdk'

const iopipe = require('iopipe')({
  token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmMjc2NDVlZS02ZGFlLTQ2MWEtOTM1NC1jMjljZWZlMjUyMzAiLCJqdGkiOiIwOTk0ZTJiZi0zZDJlLTRkYjMtOWNkZS1jNDdiNDhmOTVhOTQiLCJpYXQiOjE1MDIzODcxNzMsImlzcyI6Imh0dHBzOi8vaW9waXBlLmNvbSIsImF1ZCI6Imh0dHBzOi8vaW9waXBlLmNvbSxodHRwczovL21ldHJpY3MtYXBpLmlvcGlwZS5jb20vZXZlbnQvLGh0dHBzOi8vZ3JhcGhxbC5pb3BpcGUuY29tIn0.Jbu3lip-DXv78s4qPpWbFDEMshHnUZm0kEvBEMCWcQY'
});

exports.handler = iopipe(async function(event, context) {
  try {
    const actions = []
    const events = parseEvents(event)
    const names = Object.keys(events)
    for (const name of names) {
      const eventPayloads = events[name]
      console.log("Executing " + eventPayloads.length.toString() + " " + name + " events")
      actions.push(executeEvents(name, eventPayloads))
    }
    await Promise.all(actions)

    console.log("Handler finished")
    context.succeed();
  } catch (err) {
    console.log("Handler error: " + err)
    context.fail(err)
  }
})