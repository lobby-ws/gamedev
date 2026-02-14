export default (world, app, fetch, props, setTimeout) => {
  if (!world.isClient) return

  const block = app.get('Block')
  // if (block) block.active = false

  app.configure([
    { key: 'width', type: 'number', label: 'Width', min: 1, max: 10000, step: 1, initial: 50 },
    { key: 'height', type: 'number', label: 'Depth', min: 1, max: 10000, step: 1, initial: 50 },
    { key: 'color', type: 'color', label: 'Water Color', initial: '#001e0f' },
    { key: 'sunColor', type: 'color', label: 'Sun Color', initial: '#ffffff' },
    { key: 'sunDirX', type: 'range', label: 'Sun Dir X', min: -1, max: 1, step: 0.01, initial: 0.7 },
    { key: 'sunDirY', type: 'range', label: 'Sun Dir Y', min: -1, max: 1, step: 0.01, initial: 0.7 },
    { key: 'sunDirZ', type: 'range', label: 'Sun Dir Z', min: -1, max: 1, step: 0.01, initial: 0 },
    { key: 'distortionScale', type: 'range', label: 'Distortion', min: 0, max: 20, step: 0.1, initial: 2 },
    { key: 'speed', type: 'range', label: 'Speed', min: 0, max: 5, step: 0.1, initial: 0.1 },
    { key: 'alpha', type: 'range', label: 'Alpha', min: 0, max: 1, step: 0.05, initial: 1 },
    { key: 'reflectivity', type: 'range', label: 'Reflectivity', min: 0, max: 1, step: 0.05, initial: 0.3 },
    { key: 'textureSize', type: 'number', label: 'Texture Size', min: 64, max: 2048, step: 64, initial: 256 },
  ])

  const water = app.create('water', {
    width: props.width ?? 50,
    height: props.height ?? 50,
    color: props.color ?? '#001e0f',
    sunColor: props.sunColor ?? '#ffffff',
    sunDirection: [props.sunDirX ?? 0.7, props.sunDirY ?? 0.7, props.sunDirZ ?? 0],
    distortionScale: props.distortionScale ?? 2,
    speed: props.speed ?? 0.1,
    alpha: props.alpha ?? 1,
    reflectivity: props.reflectivity ?? 0.3,
    textureSize: props.textureSize ?? 256,
  })
  app.add(water)
}
