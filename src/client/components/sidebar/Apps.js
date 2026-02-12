import { css } from '@firebolt-dev/css'
import { useEffect, useRef, useState } from 'react'
import { RocketIcon, SearchIcon } from 'lucide-react'
import { cls } from '../cls'
import { theme } from '../theme'
import { AppsList } from '../AppsList'
import { Pane } from './Pane'

const appsState = {
  query: '',
  perf: false,
  scrollTop: 0,
}

export function Apps({ world, hidden }) {
  const contentRef = useRef()
  const [query, setQuery] = useState(appsState.query)
  const [perf, setPerf] = useState(appsState.perf)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    contentRef.current.scrollTop = appsState.scrollTop
  }, [])
  useEffect(() => {
    appsState.query = query
    appsState.perf = perf
  }, [query, perf])
  return (
    <Pane width={perf ? '40rem' : '20rem'} hidden={hidden}>
      <div
        className='apps'
        css={css`
          background: ${theme.bgSection};
          border: 1px solid ${theme.borderLight};
          border-radius: ${theme.radius};
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 17rem;
          position: relative;
          .apps-head {
            height: 3.125rem;
            padding: 0 0.6rem 0 1rem;
            border-bottom: 1px solid ${theme.borderLight};
            display: flex;
            align-items: center;
          }
          .apps-title {
            flex: 1;
            font-weight: 500;
            font-size: 1rem;
            line-height: 1;
          }
          .apps-search {
            display: flex;
            align-items: center;
            input {
              margin-left: 0.5rem;
              width: 5rem;
              font-size: 0.9375rem;
              &::placeholder {
                color: #5d6077;
              }
              &::selection {
                background-color: white;
                color: rgba(0, 0, 0, 0.8);
              }
            }
          }
          .apps-toggle {
            width: 2rem;
            height: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 0 0 1rem;
            color: #5d6077;
            &:hover {
              cursor: pointer;
            }
            &.active {
              color: white;
            }
          }
          .apps-content {
            flex: 1;
            overflow-y: auto;
          }
        `}
      >
        <div className='apps-head'>
          <div className='apps-title'>Objects</div>
          <label className='apps-search'>
            <SearchIcon size='1.125rem' />
            <input type='text' placeholder='Search' value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <div className={cls('apps-toggle', { active: perf })} onClick={() => setPerf(!perf)}>
            <RocketIcon size='1.125rem' />
          </div>
        </div>
        <div
          ref={contentRef}
          className='apps-content noscrollbar'
          onScroll={e => {
            appsState.scrollTop = contentRef.current.scrollTop
          }}
        >
          <AppsList world={world} query={query} perf={perf} refresh={refresh} setRefresh={setRefresh} />
        </div>
      </div>
    </Pane>
  )
}
