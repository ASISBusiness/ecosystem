'use client'

import { Text } from '@eth-optimism/ui-components/src/components/ui/text/text'

import { ClaimedRebateProgressBanner } from '@/app/settings/components/ClaimedRebateProgressBanner'
import { CoinbaseVerificationBanner } from '@/app/settings/components/CoinbaseVerificationBanner'
import { DeployedApps } from '@/app/settings/contracts/DeployedApps'
import { ClaimedRebates } from '@/app/settings/components/ClaimedRebates'
import { apiClient } from '@/app/helpers/apiClient'
import { useEffect } from 'react'

export default function Contracts() {
  const { mutate: syncCbVerification } =
    apiClient.wallets.syncCbVerification.useMutation()

  const { data: walletVerifications } =
    apiClient.wallets.walletVerifications.useQuery()

  useEffect(() => {
    syncCbVerification()
  }, [syncCbVerification])

  return (
    <div className="flex flex-col gap-2">
      <Text className="text-lg font-semibold">Your Apps</Text>

      <div className="flex flex-col gap-6">
        <DeployedApps />
      </div>

      <Text className="text-lg font-semibold">Your Rebates</Text>
      <div className="flex flex-col gap-4">
        {!walletVerifications?.cbVerifiedWallets && (
          <CoinbaseVerificationBanner />
        )}
        <ClaimedRebateProgressBanner />
        <ClaimedRebates />
      </div>
    </div>
  )
}
