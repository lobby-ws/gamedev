export default (world, app, fetch, props, setTimeout) => {
  app.configure([
    {
      key: 'name',
      type: 'text',
      label: 'Name',
      initial: 'NPC',
    },
  ])

  const SEND_RATE = 0.33
  const MAX_DISTANCE = 10
  const num = prng(1)

  app.get('Block').visible = false

  const emotes = [
    app.asset('./assets/walk.glb'),
    app.asset('./assets/run.glb'),
    app.asset('./assets/idle-breathing.glb'),
    app.asset('./assets/talking.glb'),
    app.asset('./assets/sit.glb'),
    app.asset('./assets/cheer.glb'),
    app.asset('./assets/dance.glb'),
  ]
  const walkEmoteIdx = 0
  const runEmoteIdx = 1
  const customEmoteIndices = [2, 3, 4, 5, 6]

  if (world.isServer) {
    const state = app.state

    state.name = app.config.name || 'NPC'
    state.vrmUrl = app.asset('./assets/avatar.vrm')

    const ctrl = app.create('controller')
    ctrl.position.copy(app.position)
    world.add(ctrl)
    const v1 = new Vector3()
    let lastSend = 0
    // TODO: actions should have chance multipliers
    const actions = [
      () => {
        // emote
        const idx = customEmoteIndices[num(0, customEmoteIndices.length - 1)]
        let time = num(1, 5, 2)
        return delta => {
          state.e = idx
          time -= delta
          // console.log('emote', idx)
          return time <= 0
        }
      },
      () => {
        // move
        let angle = num(0, 360) * DEG2RAD
        const eul = new Euler(0, angle, 0, 'YXZ')
        const qua = new Quaternion().setFromEuler(eul)
        const direction = new Vector3(0, 0, -1)
        direction.applyQuaternion(qua)
        // geo-fence
        if (app.position.distanceTo(ctrl.position) > MAX_DISTANCE) {
          // direction to origin
          direction.subVectors(app.position, ctrl.position)
          direction.y = 0
          direction.normalize()
          // randomize offset within 120 degree cone
          const baseAngle = Math.atan2(-direction.x, -direction.z)
          const randomOffset = (Math.random() - 0.5) * 120 * DEG2RAD // ±60 degrees
          angle = baseAngle + randomOffset
          // apply new angle to the direction
          const randomEul = new Euler(0, angle, 0, 'YXZ')
          const randomQua = new Quaternion().setFromEuler(randomEul)
          direction.set(0, 0, -1)
          direction.applyQuaternion(randomQua)
        }
        let time = num(1, 5, 2)
        const run = num(0, 1) === 1
        const speed = run ? 4 : 2
        return delta => {
          state.ry = angle
          v1.copy(direction).multiplyScalar(delta * speed)
          v1.y = -9.81
          ctrl.move(v1)
          state.px = ctrl.position.x
          state.py = ctrl.position.y
          state.pz = ctrl.position.z
          state.e = run ? runEmoteIdx : walkEmoteIdx
          time -= delta
          // console.log('walk', ctrl.position.toArray())
          return time <= 0
        }
      },
    ]
    function getAction() {
      return actions[num(0, actions.length - 1)]()
    }
    let action = getAction()
    app.on('fixedUpdate', delta => {
      const finished = action(delta)
      if (finished) action = getAction()
      lastSend += delta
      if (lastSend > SEND_RATE) {
        lastSend = 0
        app.send('change', [state.px, state.py, state.pz, state.ry, state.e])
      }
    })
    state.px = ctrl.position.x
    state.py = ctrl.position.y
    state.pz = ctrl.position.z
    state.ry = 0
    state.e = null
    state.ready = true
    app.send('init', state)
  }

  if (world.isClient) {
    if (app.state.ready) {
      init(app.state)
    } else {
      app.on('init', init)
    }
    function init(state) {
      const root = app.create('group')
      root.position.set(state.px, state.py, state.pz)
      const avatar = app.create('avatar', {
        src: state.vrmUrl,
      })
      const nametag = app.create('nametag', {
        label: state.name,
      })
      avatar.rotation.y = state.ry
      avatar.onLoad = () => {
        nametag.position.y = avatar.getHeight() + 0.1
        root.add(nametag)
      }
      root.add(avatar)
      world.add(root)
      const position = new BufferedLerpVector3(root.position, SEND_RATE * 1.2)
      app.on('change', ([px, py, pz, ry, e]) => {
        position.push([px, py, pz])
        avatar.rotation.y = ry
        avatar.emote = emotes[e]
      })
      app.on('update', delta => {
        position.update(delta)
      })
    }
  }
}
