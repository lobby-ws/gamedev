import { useEffect, useRef, useState } from 'react'
import { css } from '@firebolt-dev/css'
import { loadMonaco } from './monaco'
// editor will remember a single script so you can flip between tabs without hitting save (eg viewing docs)
const cached = {
  key: null,
  viewState: null,
  value: null,
  model: null,
}

export function ScriptEditor({ app, onHandle }) {
  const key = app.data.id
  const mountRef = useRef()
  const codeRef = useRef()
  const [editor, setEditor] = useState(null)
  const [fontSize, setFontSize] = useState(() => 12 * app.world.prefs.ui)
  const copy = async () => {
    const text = editor ? editor.getValue() : codeRef.current || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      app.world.emit('toast', 'Code copied')
    } catch (err) {
      console.error(err)
      app.world.emit('toast', 'Copy failed')
    }
  }
  const saveState = () => {
    if (editor) {
      cached.key = key
      cached.viewState = editor.saveViewState()
      cached.model = editor.getModel()
      cached.value = editor.getValue()
    }
  }
  useEffect(() => {
    onHandle?.({ copy })
  }, [editor])
  useEffect(() => {
    const onPrefsChange = changes => {
      if (changes.ui) {
        setFontSize(14 * changes.ui.value)
      }
    }
    app.world.prefs.on('change', onPrefsChange)
    return () => {
      app.world.prefs.off('change', onPrefsChange)
    }
  }, [])
  useEffect(() => {
    if (editor) {
      editor.updateOptions({ fontSize })
    }
  }, [editor, fontSize])
  useEffect(() => {
    return () => {
      saveState()
      editor?.dispose()
    }
  }, [editor])
  useEffect(() => {
    let dead
    loadMonaco().then(monaco => {
      if (dead) return
      // only use cached if it matches this key
      const state = cached.key === key ? cached : null
      const initialCode = state?.value ?? app.script?.code ?? '// …'
      const uri = monaco.Uri.parse(`inmemory://model/${key}`)
      let model = monaco.editor.getModel(uri)
      if (!model) {
        model = monaco.editor.createModel(initialCode, 'javascript', uri)
      } else if (model.getValue() !== initialCode) {
        model.setValue(initialCode)
      }
      codeRef.current = initialCode
      const editor = monaco.editor.create(mountRef.current, {
        model,
        // value: codeRef.current,
        language: 'javascript',
        scrollBeyondLastLine: true,
        lineNumbers: 'on',
        minimap: { enabled: false },
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        fontSize: fontSize,
        readOnly: true,
      })
      if (state?.viewState) {
        editor.restoreViewState(state.viewState)
        editor.focus()
      }
      editor.onDidChangeModelContent(event => {
        codeRef.current = editor.getValue()
      })
      setEditor(editor)
      // watch changes
      app.onScript = () => {
        const newCode = app.script?.code || '// ...'
        if (newCode !== codeRef.current) {
          editor.setValue(newCode)
          codeRef.current = newCode
        }
      }
    })
    return () => {
      dead = true
    }
  }, [])
  
  // Listen for blueprint modifications to update editor content
  useEffect(() => {
    if (!editor) return
    
    const onBlueprintModify = bp => {
      // Only update if this is the same blueprint as our current app
      console.log('debug: blueprint modified', {bp, app})
      if (bp.id !== app.blueprint.id) return
      console.log('isSelectedBlueprint')
      // Load the new script content
      const loadNewScript = async () => {
        try {
          let newCode = '// …'
          if (bp.script) {
            // Load the script using the world loader
            let script = app.world.loader.get('script', bp.script)
            if (!script) {
              script = await app.world.loader.load('script', bp.script)
            }
            if (script?.code) {
              newCode = script.code
            }
          }
          editor.setValue(newCode)
          codeRef.current = newCode
          if (cached.key === key) {
            cached.value = newCode
            cached.viewState = null
          }
        } catch (error) {
          console.error('Failed to load updated script:', error)
        }
      }
      
      loadNewScript()
    }
    
    app.world.blueprints.on('modify', onBlueprintModify)
    
    return () => {
      app.world.blueprints.off('modify', onBlueprintModify)
    }
  }, [editor, app, key])

  return (
    <div
      className='editor'
      css={css`
        flex: 1;
        position: relative;
        overflow: hidden;
        border-bottom-left-radius: 10px;
        border-bottom-right-radius: 10px;
        .editor-mount {
          position: absolute;
          inset: 0;
          /* top: 20px; */
        }
        .monaco-editor {
          // removes the blue focus border
          --vscode-focusBorder: #00000000 !important;
        }
      `}
    >
      <div className='editor-mount' ref={mountRef} />
    </div>
  )
}