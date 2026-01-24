import { formatGreeting } from './lib/greeting.js'

export default (world, app, fetch, props) => {
  app.configure([
    {
      key: 'message',
      type: 'text',
      label: 'Message',
      initial: 'Hello from module mode',
    },
  ])

  const message = typeof props?.message === 'string' ? props.message : 'Hello from module mode'
  console.log(formatGreeting(message))
}
