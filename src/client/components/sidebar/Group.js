import { css } from '@firebolt-dev/css'

export function Group({ label }) {
  return (
    <>
      <div
        css={css`
          height: 0.0625rem;
          background: rgba(255, 255, 255, 0.05);
          margin: 0.6rem 0;
        `}
      />
      {label && (
        <div
          css={css`
            font-weight: 500;
            line-height: 1;
            padding: 0.75rem 0 0.75rem 1rem;
            margin-top: -0.6rem;
          `}
        >
          {label}
        </div>
      )}
    </>
  )
}
