const COLORS = [
  '#e74c3c', // 0  red
  '#f39c12', // 1  orange
  '#f1c40f', // 2  yellow
  '#2ecc71', // 3  green
  '#1abc9c', // 4  teal
  '#3498db', // 5  blue
  '#6d28d9', // 6  purple
  '#e91e9b', // 7  pink
  '#00e5ff', // 8  cyan
  '#ff6e40', // 9  coral
]

export default (world, app, fetch, props, setTimeout) => {
  app.configure([
    {
      key: 'teleporterId',
      type: 'number',
      label: 'Teleporter ID',
      initial: 0,
      min: 0,
      step: 1,
    },
    {
      key: 'visible',
      type: 'toggle',
      label: 'Visible',
      initial: true,
    },
  ])

  const block = app.get('Block')
  if (block) block.active = false

  const color = COLORS[props.teleporterId % COLORS.length]

  const pad = app.create('prim', {
    type: 'box',
    size: [1, 1, 1],
    position: [0, 0.5, 0],
    color: color,
    opacity: props.visible ? 0.5 : 0,
    transparent: true,
    physics: 'static',
    trigger: true,
    onTriggerEnter: e => {
      if (!e.isLocalPlayer) return
      app.emit('teleport', {
        playerId: e.playerId,
        teleporterId: props.teleporterId,
      })
    },
  })
  app.add(pad)
}
