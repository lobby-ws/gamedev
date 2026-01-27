export default (world, app, fetch, props, setTimeout) => {
app.get('Block').active = false

app.configure(() => {
  return [
    {
      key: 'sky',
      label: 'Sky',
      type: 'file',
      kind: 'texture',
      hint: 'The image to use as the background.',
    },
    {
      key: 'hdr',
      label: 'HDR',
      type: 'file',
      kind: 'hdr',
      hint: 'The HDRI to use for reflections and lighting.',
    },
    {
      key: 'rotationY',
      label: 'Rotation',
      type: 'number',
      step: 10,
      bigStep: 50,
    },
    {
      key: '002',
      type: 'section',
      label: 'Sun',
    },
    {
      key: 'horizontalRotation',
      label: 'Direction',
      type: 'number',
      min: 0,
      max: 360,
      step: 10,
      bigStep: 50,
      initial: 0,
      dp: 0,
      hint: 'The direction of the sun in degrees',
    },
    {
      key: 'verticalRotation',
      label: 'Elevation',
      type: 'number',
      min: 0,
      max: 360,
      step: 10,
      bigStep: 50,
      initial: 0,
      dp: 0,
      hint: 'The elevation of the sun in degrees',
    },
    {
      key: 'intensity',
      label: 'Intensity',
      type: 'number',
      min: 0,
      max: 10,
      step: 0.1,
      initial: 1,
      dp: 1,
    },
    {
      key: '003',
      type: 'section',
      label: 'Fog',
    },
    {
      key: 'fogColor',
      label: 'Color',
      type: 'text',
      hint: 'The fog color. Leave blank to disable fog',
    },
    {
      key: 'fogNear',
      label: 'Near',
      type: 'number',
      dp: 0,
      min: 0,
      step: 10,
      initial: 0,
      hint: 'The near distance for fog in metres',
    },
    {
      key: 'fogFar',
      label: 'Far',
      type: 'number',
      dp: 0,
      min: 0,
      step: 10,
      initial: 1000,
      hint: 'The far distance for fog in metres',
    },
  ]
})

const sky = app.create('sky')

sky.bg = app.config.sky?.url
sky.hdr = app.config.hdr?.url
sky.rotationY = app.config.rotationY * -DEG2RAD

const sunDirection = calculateSunDirection(app.config.verticalRotation || 0, app.config.horizontalRotation || 0)
sky.sunDirection = sunDirection
sky.sunIntensity = app.config.intensity

sky.fogNear = app.config.fogNear
sky.fogFar = app.config.fogFar
sky.fogColor = app.config.fogColor

app.add(sky)

// Create solid black floor
const floor = app.create('prim', {
  type: 'box',
  size: [50, 0.1, 50], // Same 50x50 meter area
  position: [0, -0.05, 0], // Slightly below ground level
  color: '#000000', // Solid black
  roughness: 0.5,
  physics: 'static',
  opacity: 0.5,
  receiveShadow: true,
  castShadow: false,
})

app.add(floor)

// Create random world space UI for testing
const testUI = app.create('ui', {
  space: 'world',
  width: 300,
  height: 200,
  size: 0.01, // 1 pixel = 1cm
  position: [5, 2, 0],
  backgroundColor: 'rgba(20, 30, 50, 0.8)',
  borderWidth: 2,
  borderColor: '#00ff88',
  borderRadius: 10,
  padding: 20,
  billboard: 'full', // Always face the camera
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  gap: 10,
})

// Add title text
const titleText = app.create('uitext', {
  value: 'Test UI Panel',
  fontSize: 24,
  color: '#ffffff',
  fontWeight: 'bold',
  textAlign: 'center',
})

// Add subtitle
const subtitleText = app.create('uitext', {
  value: 'World Space UI Testing',
  fontSize: 14,
  color: '#00ff88',
  textAlign: 'center',
  margin: 5,
})

// Add some info text
const infoText = app.create('uitext', {
  value: 'This UI follows you around!\nPosition: (5, 2, 0)\nBillboard: Full',
  fontSize: 12,
  color: '#cccccc',
  textAlign: 'center',
  lineHeight: 1.4,
})

// Build the UI hierarchy
testUI.add(titleText)
testUI.add(subtitleText)
testUI.add(infoText)
app.add(testUI)

// Create a second floating UI with different properties
const floatingUI = app.create('ui', {
  space: 'world',
  width: 150,
  height: 150,
  size: 0.008,
  position: [-3, 1.5, 2],
  backgroundColor: 'rgba(80, 20, 80, 0.9)',
  borderRadius: 75, // Make it circular
  padding: 15,
  billboard: 'y', // Only rotate around Y axis
  justifyContent: 'center',
  alignItems: 'center',
})

const circularText = app.create('uitext', {
  value: '🌟\nFloating\nCircle UI\n🌟',
  fontSize: 14,
  color: '#ffff00',
  textAlign: 'center',
  fontWeight: 'bold',
  lineHeight: 1.2,
})

floatingUI.add(circularText)
app.add(floatingUI)

function calculateSunDirection(verticalDegrees, horizontalDegrees) {
  const verticalRad = verticalDegrees * DEG2RAD
  const horizontalRad = horizontalDegrees * DEG2RAD
  const x = Math.sin(verticalRad) * Math.sin(horizontalRad)
  const y = -Math.cos(verticalRad) // Negative because 0° should point down
  const z = Math.sin(verticalRad) * Math.cos(horizontalRad)
  return new Vector3(x, y, z)
}
}