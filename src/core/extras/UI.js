toggleApps() {
  this.world.events.emit('apps', !this.world.events.query('apps'))
}

toggleHyperliquid() {
  this.world.events.emit('hyperliquid', !this.world.events.query('hyperliquid'))
}

toggleInspect() {
  // ... existing code ...
} 