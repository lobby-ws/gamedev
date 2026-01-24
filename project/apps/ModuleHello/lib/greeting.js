export function formatGreeting(message) {
  const safe = typeof message === 'string' && message.trim() ? message.trim() : 'Hello from module mode'

  console.log('from outside')
  return `ModuleHello: ${safe}`
}


console.log('damn')