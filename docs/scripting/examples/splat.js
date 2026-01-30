export default (world, app, fetch, props, setTimeout) => {
  app.configure([
    {
      key: 'file',
      type: 'file',
      kind: 'splat',
      label: 'Splat File',
    },
    {
      key: 'collisionFile',
      type: 'file',
      kind: 'model',
      label: 'Collision Mesh',
      hint: 'Optional GLB file containing collision geometry',
    },
    {
      key: 'blockVisible',
      type: 'toggle',
      label: 'Block Visible',
      initial: true,
    },
  ])

  let splatLoaded = false
  let collisionLoaded = false
  const block = app.get('Block')

  app.on('update', () => {
    const url = props.file?.url
    if (url && !splatLoaded) {
      splatLoaded = true
      loadSplat(url)
    }

    const collisionUrl = props.collisionFile?.url
    if (collisionUrl && !collisionLoaded) {
      collisionLoaded = true
      loadCollisionMesh(collisionUrl)
    }

    if (block && props.blockVisible) {
      block.active = true
    } else {
      block.active = false
    }
  })

  async function loadSplat(url) {
    try {
      const splatNode = await world.load('splat', url)
      app.add(splatNode)
    } catch (err) {
      console.error('Failed to load splat:', err)
    }
  }

  async function loadCollisionMesh(url) {
    try {
      const model = await world.load('model', url)
      app.add(model)

      const m1 = new Matrix4()
      const appInverseMatrix = app.matrixWorld.clone().invert()
      const body = app.create('rigidbody')

      model.traverse(node => {
        if (node.name === 'mesh') {
          node.active = false
          const collider = app.create('collider')
          collider.type = 'geometry'
          collider.geometry = node.geometry
          m1.copy(node.matrixWorld)
            .premultiply(appInverseMatrix)
            .decompose(collider.position, collider.quaternion, collider.scale)
          body.add(collider)
        }
      })

      body.position.copy(app.position)
      body.quaternion.copy(app.quaternion)
      body.scale.copy(app.scale)
      world.add(body)
    } catch (err) {
      console.error('Failed to load collision mesh:', err)
    }
  }
}
