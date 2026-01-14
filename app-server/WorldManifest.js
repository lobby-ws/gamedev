import fs from 'fs'
import path from 'path'

export class WorldManifest {
  constructor(filePath) {
    this.filePath = filePath
    this.data = null
  }

  read() {
    if (!fs.existsSync(this.filePath)) {
      return null
    }
    try {
      const content = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(content)

      if (!parsed || typeof parsed !== 'object') {
        return null
      }

      if (parsed.formatVersion !== 2) {
        throw new Error(
          'Invalid world.json format version. Expected formatVersion 2.\n' +
            'Run "hyperfy world export" to regenerate world.json (formatVersion 2).'
        )
      }

      this.data = parsed
      return parsed
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  write(manifest) {
    this.data = manifest
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  validate(data) {
    const errors = []

    if (!data || typeof data !== 'object') {
      errors.push('world.json must be an object')
      return errors
    }

    if (data.formatVersion !== 2) {
      errors.push('formatVersion must be 2')
    }

    if (!data.settings || typeof data.settings !== 'object') {
      errors.push('settings must be an object')
    }

    if (!data.spawn || typeof data.spawn !== 'object') {
      errors.push('spawn must be an object')
    } else {
      if (!Array.isArray(data.spawn.position) || data.spawn.position.length !== 3) {
        errors.push('spawn.position must be an array of 3 numbers')
      }
      if (!Array.isArray(data.spawn.quaternion) || data.spawn.quaternion.length !== 4) {
        errors.push('spawn.quaternion must be an array of 4 numbers')
      }
    }

    if (!Array.isArray(data.entities)) {
      errors.push('entities must be an array')
    } else {
      data.entities.forEach((entity, index) => {
        if (!entity.id || typeof entity.id !== 'string') {
          errors.push(`entities[${index}].id must be a string`)
        }
        if (!entity.blueprint || typeof entity.blueprint !== 'string') {
          errors.push(`entities[${index}].blueprint must be a string`)
        }
        if (!Array.isArray(entity.position) || entity.position.length !== 3) {
          errors.push(`entities[${index}].position must be an array of 3 numbers`)
        }
        if (!Array.isArray(entity.quaternion) || entity.quaternion.length !== 4) {
          errors.push(`entities[${index}].quaternion must be an array of 4 numbers`)
        }
        if (!Array.isArray(entity.scale) || entity.scale.length !== 3) {
          errors.push(`entities[${index}].scale must be an array of 3 numbers`)
        }
        if (typeof entity.pinned !== 'boolean') {
          errors.push(`entities[${index}].pinned must be a boolean`)
        }
        if (entity.props !== undefined) {
          if (!entity.props || typeof entity.props !== 'object' || Array.isArray(entity.props)) {
            errors.push(`entities[${index}].props must be an object`)
          }
        }
        if (!entity.state || typeof entity.state !== 'object') {
          errors.push(`entities[${index}].state must be an object`)
        }
      })
    }

    return errors
  }

  createEmpty() {
    return {
      formatVersion: 2,
      settings: {
        title: null,
        desc: null,
        image: null,
        avatar: null,
        customAvatars: false,
        voice: 'spatial',
        rank: 0,
        playerLimit: 0,
        ao: true,
      },
      spawn: {
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
      },
      entities: [],
    }
  }

  fromSnapshot(snapshot) {
    const manifest = this.createEmpty()

    if (snapshot.settings && typeof snapshot.settings === 'object') {
      manifest.settings = { ...manifest.settings, ...snapshot.settings }
    }

    if (snapshot.spawn && typeof snapshot.spawn === 'object') {
      manifest.spawn = {
        position: Array.isArray(snapshot.spawn.position) ? snapshot.spawn.position.slice(0, 3) : [0, 0, 0],
        quaternion: Array.isArray(snapshot.spawn.quaternion) ? snapshot.spawn.quaternion.slice(0, 4) : [0, 0, 0, 1],
      }
    }

    if (Array.isArray(snapshot.entities)) {
      manifest.entities = snapshot.entities
        .filter(e => e.type === 'app')
        .map(e => ({
          id: e.id,
          blueprint: e.blueprint,
          position: Array.isArray(e.position) ? e.position.slice(0, 3) : [0, 0, 0],
          quaternion: Array.isArray(e.quaternion) ? e.quaternion.slice(0, 4) : [0, 0, 0, 1],
          scale: Array.isArray(e.scale) ? e.scale.slice(0, 3) : [1, 1, 1],
          pinned: Boolean(e.pinned),
          props: e.props && typeof e.props === 'object' && !Array.isArray(e.props) ? e.props : {},
          state: e.state && typeof e.state === 'object' ? e.state : {},
        }))
    }

    return manifest
  }
}
