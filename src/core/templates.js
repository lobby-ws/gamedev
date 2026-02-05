export const ENGINE_TEMPLATES = [
  {
    id: 'Model',
    name: 'Model',
    image: {
      url: 'asset://Model.png',
    },
    model: 'asset://Model.glb',
    script: 'asset://Model.js',
    scriptEntry: 'Model.js',
    scriptFiles: {
      'Model.js': 'asset://Model.js',
    },
    scriptFormat: 'module',
    props: {
      collision: true,
    },
    preload: false,
    public: false,
    locked: false,
    frozen: false,
    unique: true,
    scene: false,
    disabled: false,
  },
  {
    id: 'Image',
    name: 'Image',
    image: {
      url: 'asset://Image.png',
    },
    model: 'asset://Image.glb',
    script: 'asset://Image.js',
    scriptEntry: 'Image.js',
    scriptFiles: {
      'Image.js': 'asset://Image.js',
    },
    scriptFormat: 'module',
    props: {
      width: 0,
      height: 2,
      fit: 'cover',
      image: null,
      transparent: false,
      lit: false,
      shadows: true,
      placeholder: {
        type: 'image',
        url: 'asset://Image.png',
      },
    },
    preload: false,
    public: false,
    locked: false,
    frozen: false,
    unique: true,
    scene: false,
    disabled: false,
  },
  {
    id: 'Video',
    name: 'Video',
    image: {
      url: 'asset://Video.png',
    },
    model: 'asset://Video.glb',
    script: 'asset://Video.js',
    scriptEntry: 'Video.js',
    scriptFiles: {
      'Video.js': 'asset://Video.js',
    },
    scriptFormat: 'module',
    props: {
      width: 0,
      height: 2,
      fit: 'cover',
      url: null,
      loop: true,
      autoplay: true,
      transparent: false,
      lit: false,
      shadows: true,
      placeholder: {
        type: 'video',
        url: 'asset://Video.mp4',
      },
    },
    preload: false,
    public: false,
    locked: false,
    frozen: false,
    unique: true,
    scene: false,
    disabled: false,
  },
  {
    id: 'Text',
    name: 'Text',
    image: {
      url: 'asset://Text.png',
    },
    model: 'asset://Text.glb',
    script: 'asset://Text.js',
    scriptEntry: 'Text.js',
    scriptFiles: {
      'Text.js': 'asset://Text.js',
    },
    scriptFormat: 'module',
    props: {
      width: 200,
      height: 200,
      text: 'Enter text...',
      fontSize: 20,
      fontWeight: 'bold',
      color: '#ffffff',
      transparent: false,
      lit: false,
      shadows: true,
    },
    preload: false,
    public: false,
    locked: false,
    frozen: false,
    unique: true,
    scene: false,
    disabled: false,
  },
  {
    id: 'Webview',
    name: 'Webview',
    image: {
      url: 'asset://Webview.png',
    },
    model: 'asset://Webview.glb',
    script: 'asset://Webview.js',
    scriptEntry: 'Webview.js',
    scriptFiles: {
      'Webview.js': 'asset://Webview.js',
    },
    scriptFormat: 'module',
    props: {
      url: 'https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1',
    },
    preload: false,
    public: false,
    locked: false,
    frozen: false,
    unique: true,
    scene: false,
    disabled: false,
  },
]

const TEMPLATE_INDEX = new Map(ENGINE_TEMPLATES.map(template => [template.id, template]))

export function getEngineTemplate(id) {
  if (!id) return null
  return TEMPLATE_INDEX.get(id) || null
}
