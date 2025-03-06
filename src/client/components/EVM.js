import { createConfig, http, injected, useDisconnect, WagmiProvider } from 'wagmi'
import * as chains from 'wagmi/chains'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
const queryClient = new QueryClient()

const chainStr = process.env.PUBLIC_EVM ?? 'mainnet'
const chain = chains[chainStr]
if (!chain) throw new Error('invalid chain name')

const transports = {
  [chain.id]: http(),
}

export const Providers = ({ children }) => (
  <WagmiProvider
    config={createConfig({
      chains: [chain],
      transports,
      connectors: [injected()],
      multiInjectedProviderDiscovery: false,
    })}
  >
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </WagmiProvider>
)

export function EVM({ world }) {
  return (
    <Providers>
      <Logic world={world} />
    </Providers>
  )
}

import * as evmActions from 'wagmi/actions'
import { useConfig, useAccount } from 'wagmi'
import * as utils from 'viem/utils'
import { erc20Abi } from 'viem'

import { useConnect, useConnectors } from 'wagmi'
import { useState, useEffect } from 'react'

function Logic({ world }) {
  const config = useConfig()
  const { address, isConnected, isConnecting, isReconnecting, isDisconnected } = useAccount()
  const [initialized, setInitialized] = useState(false)
  // useEffect(() => {
  //   if (initialized) return
  //   setInitialized(true)

  //   let evm = { actions: {}, utils }
  //   for (const [action, fn] of Object.entries(evmActions)) {
  //     evm.actions[action] = (...args) => fn(config, ...args)
  //   }
  //   evm.abis = {
  //     erc20: erc20Abi,
  //     erc721: null,
  //   }

  //   world.evm = evm
  // }, [config])

  // useEffect(() => {
  //   const handlePlayer = player => {
  //     // console.log({ player, address })
  //     world.entities.player.modify({ evm: address })
  //     world.off('player', handlePlayer)
  //   }
  //   world.on('player', handlePlayer)

  //   if (!world.entities?.player) return
  //   world.entities.player.modify({ evm: address })

  //   return () => {
  //     world.off(handlePlayer)
  //   }
  // }, [address, world.entities?.player])

  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()

  useEffect(() => {
    let actions = {}

    // for (const [action, fn] of Object.entries(evmActions)) {
    //   actions[action] = (...args) => fn(config, ...args)
    // }
    const abis = {
      erc20: erc20Abi,
      erc721: null,
    }

    world.evm.bind({
      connectors,
      connect,
      disconnect,
      address,
      actions: evmActions,
      abis,
      config,
      isConnected,
      isConnecting,
    })
  }, [isConnected, isConnecting, address])
}
