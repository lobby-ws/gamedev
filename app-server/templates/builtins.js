export const BUILTIN_APP_TEMPLATES = []

export const SCENE_TEMPLATE = {
  appName: '$scene',
  fileBase: '$scene',
  scriptAsset: 'scene.js',
  config: {
    scriptFormat: 'module',
    image: null,
    author: null,
    url: null,
    desc: null,
    model: 'asset://Model.glb',
    props: {
      hour: 4,
      period: 'pm',
      intensity: 1,
      sky: {
        url: 'asset://sky.jpg',
      },
      hdr: {
        url: 'asset://sky.hdr',
      },
      verticalRotation: 40,
      horizontalRotation: 230,
      rotationY: 0,
      fogNear: 450,
      fogFar: 1000,
      fogColor: '#97b4d3',
    },
    preload: true,
    public: false,
    locked: false,
    frozen: false,
    unique: false,
    scene: true,
    disabled: false,
  },
}

export const BUILTIN_BLUEPRINT_IDS = new Set([
  SCENE_TEMPLATE.fileBase,
])
