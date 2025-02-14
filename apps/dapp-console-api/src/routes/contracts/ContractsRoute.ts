import type { Address } from 'viem'
import { getAddress } from 'viem'

import {
  zodEthereumAddress,
  zodEthereumSignature,
  zodEthereumTransactionHash,
  zodSupportedChainId,
} from '@/api'
import { supportedChainsPublicClientsMap } from '@/constants'
import { isPrivyAuthed } from '@/middleware'
import {
  ChallengeState,
  completeChallenge,
  ContractState,
  deleteContract,
  getActiveContract,
  getActiveContractsForApp,
  getChallengeByChallengeId,
  getContractByAddressAndChainId,
  getUnexpiredChallenge,
  hasAlreadyVerifiedDeployer,
  insertChallenge,
  insertContract,
  insertTransaction,
  restoreDeletedContract,
  verifyContract,
  viemContractDeploymentTransactionToDbTransaction,
} from '@/models'
import { metrics } from '@/monitoring/metrics'
import { Trpc } from '@/Trpc'
import {
  addRebateEligibilityToContract,
  addressEqualityCheck,
  generateChallenge,
} from '@/utils'

import { Route } from '../Route'
import { assertUserAuthenticated } from '../utils'

export class ContractsRoute extends Route {
  public readonly name = 'Contracts' as const

  public readonly listContractsForApp = 'listContractsForApp' as const
  /**
   * Returns a list of contracts associated with an app.
   */
  public readonly listContractsForAppController = this.trpc.procedure
    .use(isPrivyAuthed(this.trpc))
    .input(
      this.z.object({
        appId: this.z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const { user } = ctx.session

        assertUserAuthenticated(user)

        const contracts = await getActiveContractsForApp({
          db: this.trpc.database,
          entityId: user.entityId,
          appId: input.appId,
        })

        return contracts.map((contract) =>
          addRebateEligibilityToContract(contract),
        )
      } catch (err) {
        metrics.listContractsErrorCount.inc()
        this.logger?.error(
          {
            error: err,
            entityId: ctx.session.user?.entityId,
            privyDid: ctx.session.user?.privyDid,
          },
          'error fetching contracts from db',
        )
        throw Trpc.handleStatus(500, 'error fetching contracts')
      }
    })

  public readonly createContract = 'createContract' as const
  public readonly createContractController = this.trpc.procedure
    .use(isPrivyAuthed(this.trpc))
    .input(
      this.z.object({
        contractAddress: zodEthereumAddress,
        deploymentTxHash: zodEthereumTransactionHash,
        deployerAddress: zodEthereumAddress,
        chainId: zodSupportedChainId,
        appId: this.z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { user } = ctx.session
      const { deploymentTxHash, chainId, appId } = input
      const inputContractAddress = getAddress(input.contractAddress)
      const inputDeployerAddress = getAddress(input.deployerAddress)

      assertUserAuthenticated(user)

      const publicClient = supportedChainsPublicClientsMap[chainId]

      if (!publicClient) {
        throw Trpc.handleStatus(400, 'chain not supported')
      }

      const deploymentTx = await publicClient
        .getTransaction({
          hash: deploymentTxHash,
        })
        .catch((err) => {
          metrics.fetchingTxErrorCount.inc({ chainId })
          this.logger?.error(
            {
              error: err,
              entityId: user.entityId,
              txHash: deploymentTxHash,
              chainId,
            },
            'error fetching tx',
          )
          throw Trpc.handleStatus(400, 'error fetching deployment transaction')
        })
      const deploymentTxReceipt = await publicClient
        .getTransactionReceipt({
          hash: deploymentTxHash,
        })
        .catch((err) => {
          metrics.fetchingTxErrorCount.inc({ chainId })
          this.logger?.error(
            {
              error: err,
              entityId: user.entityId,
              txHash: deploymentTxHash,
              chainId,
            },
            'error fetching tx receipt',
          )
          throw Trpc.handleStatus(400, 'error fetching deployment transaction')
        })
      const deploymentBlock = await publicClient
        .getBlock({
          blockHash: deploymentTx.blockHash,
        })
        .catch((err) => {
          metrics.fetchingTxErrorCount.inc({ chainId })
          this.logger?.error(
            {
              error: err,
              entityId: user.entityId,
              txHash: deploymentTxHash,
              chainId,
            },
            'error fetching tx deployment block',
          )
          throw Trpc.handleStatus(400, 'error fetching deployment transaction')
        })

      let txContractAddress: Address | null =
        deploymentTxReceipt.contractAddress || null
      if (!deploymentTxReceipt.contractAddress) {
        const tracedTransaction = await publicClient
          .traceTransaction(deploymentTxHash)
          .catch((err) => {
            metrics.traceTxErrorCount.inc({ chainId })
            this.logger?.error(
              {
                error: err,
                entityId: user.entityId,
                txHash: deploymentTxHash,
                chainId,
              },
              'unable to trace transaction',
            )
            throw Trpc.handleStatus(
              500,
              'error fetching deployment transaction',
            )
          })

        if (
          tracedTransaction &&
          tracedTransaction.calls?.length === 1 &&
          tracedTransaction.calls[0].type === 'CREATE2'
        ) {
          txContractAddress = tracedTransaction.calls[0].to
        }
      }

      if (!txContractAddress) {
        throw Trpc.handleStatus(
          400,
          'the provided deployment transaction did not create a contract',
        )
      }

      if (
        !addressEqualityCheck(deploymentTxReceipt.from, inputDeployerAddress)
      ) {
        throw Trpc.handleStatus(
          400,
          'deployer address does not match deployment transaction',
        )
      }

      if (!addressEqualityCheck(txContractAddress, inputContractAddress)) {
        throw Trpc.handleStatus(
          400,
          'contract was not created by deployment transaction',
        )
      }

      const result = await this.trpc.database
        .transaction(async (tx) => {
          const isDeployerVerified = await hasAlreadyVerifiedDeployer({
            db: tx,
            entityId: user.entityId,
            deployerAddress: inputDeployerAddress,
          })

          const existingContract = await getContractByAddressAndChainId({
            db: tx,
            contractAddress: inputContractAddress,
            chainId,
            entityId: user.entityId,
          })
          if (
            existingContract &&
            existingContract.state !== ContractState.DELETED
          ) {
            throw Trpc.handleStatus(400, 'contract already exists')
          }

          if (existingContract) {
            const restoredContract = await restoreDeletedContract({
              db: tx,
              contractId: existingContract.id,
              appId,
              state: isDeployerVerified
                ? ContractState.VERIFIED
                : ContractState.NOT_VERIFIED,
            }).catch((err) => {
              metrics.restoreDeletedContractErrorCount.inc()
              this.logger?.error(
                {
                  error: err,
                  entityId: user.entityId,
                  contractId: existingContract.id,
                  appId,
                  chainId,
                },
                'error restoring deleted contract',
              )
              throw Trpc.handleStatus(500, 'error restoring deleted contract')
            })
            return restoredContract
          } else {
            const contract = await insertContract({
              db: tx,
              contract: {
                contractAddress: inputContractAddress,
                deploymentTxHash,
                deployerAddress: inputDeployerAddress,
                chainId,
                appId,
                state: isDeployerVerified
                  ? ContractState.VERIFIED
                  : ContractState.NOT_VERIFIED,
                entityId: user.entityId,
              },
            })
            await insertTransaction({
              db: tx,
              transaction: viemContractDeploymentTransactionToDbTransaction({
                transactionReceipt: deploymentTxReceipt,
                transaction: deploymentTx,
                entityId: user.entityId,
                chainId,
                contractId: contract.id,
                deploymentTimestamp: deploymentBlock.timestamp,
              }),
            })
            return contract
          }
        })
        .catch((err) => {
          metrics.insertContractErrorCount.inc()
          this.logger?.error(
            {
              error: err,
              entityId: user.entityId,
              contractAddress: inputContractAddress,
              chainId,
            },
            'error inserting new contract',
          )
          throw Trpc.handleStatus(500, 'error creating contract')
        })

      return { result }
    })

  public readonly startVerification = 'startVerification' as const
  public readonly startVerificationController = this.trpc.procedure
    .use(isPrivyAuthed(this.trpc))
    .input(
      this.z.object({
        contractId: this.z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { contractId } = input
      const { user } = ctx.session

      assertUserAuthenticated(user)

      const contract = await getActiveContract({
        db: this.trpc.database,
        contractId,
        entityId: user.entityId,
      }).catch((err) => {
        metrics.fetchContractErrorCount.inc()
        this.logger?.error(
          {
            error: err,
            entityId: user.entityId,
            contractId,
          },
          'error fetching contract',
        )
        throw Trpc.handleStatus(500, 'error fetching contract')
      })

      if (!contract) {
        throw Trpc.handleStatus(400, 'contract does not exist')
      }

      if (contract.state === ContractState.VERIFIED) {
        throw Trpc.handleStatus(400, 'contract is already verified')
      }

      const challenge = await getUnexpiredChallenge({
        db: this.trpc.database,
        entityId: user.entityId,
        contractId,
      }).catch((err) => {
        metrics.fetchChallengeErrorCount.inc()
        this.logger?.error(
          {
            error: err,
            entityId: user.entityId,
            contractId,
          },
          'error fetching unexpired challenge',
        )
        throw Trpc.handleStatus(500, 'error fetching challenge')
      })

      const challengeToComplete = generateChallenge(contract.deployerAddress)

      if (challenge) {
        return {
          ...challenge,
          challenge: challengeToComplete,
        }
      }

      const result = await insertChallenge({
        db: this.trpc.database,
        challenge: {
          entityId: user.entityId,
          contractId,
          address: contract.deployerAddress,
          chainId: contract.chainId,
          state: ChallengeState.PENDING,
        },
      }).catch((err) => {
        metrics.insertChallengeErrorCount.inc()
        this.logger?.error(
          {
            error: err,
            entityId: user.entityId,
            contractId,
          },
          'error inserting challenge',
        )
        throw Trpc.handleStatus(500, 'error creating challenge')
      })

      return { ...result, challenge: challengeToComplete }
    })

  public readonly completeVerification = 'completeVerification' as const
  public readonly completeVerificationController = this.trpc.procedure
    .use(isPrivyAuthed(this.trpc))
    .input(
      this.z.object({
        challengeId: this.z.string(),
        signature: zodEthereumSignature,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { challengeId, signature } = input
      const { user } = ctx.session

      assertUserAuthenticated(user)

      const challenge = await getChallengeByChallengeId({
        db: this.trpc.database,
        entityId: user.entityId,
        challengeId,
      }).catch((err) => {
        metrics.fetchChallengeErrorCount.inc()
        this.logger?.error(
          {
            error: err,
            entityId: user.entityId,
            challengeId,
          },
          'error fetching challenge',
        )
        throw Trpc.handleStatus(500, 'error fetching challenge')
      })

      if (!challenge || challenge?.state === ChallengeState.EXPIRED) {
        throw Trpc.handleStatus(400, 'challenge does not exist or is expired')
      }

      const publicClient = supportedChainsPublicClientsMap[challenge.chainId]

      if (!publicClient) {
        throw Trpc.handleStatus(
          500,
          `challenge is on invalid chain id: ${challenge.chainId}`,
        )
      }

      const result = await publicClient.verifyMessage({
        address: challenge.address,
        message: generateChallenge(challenge.address),
        signature,
      })

      if (!result) {
        throw Trpc.handleStatus(400, 'challenge was not completed successfully')
      }

      await this.trpc.database
        .transaction(async (tx) => {
          await completeChallenge({
            db: tx,
            entityId: user.entityId,
            challengeId,
          })
          await verifyContract({
            db: tx,
            entityId: user.entityId,
            contractId: challenge.contractId,
          })
        })
        .catch((err) => {
          metrics.completeChallengeErrorCount.inc()
          this.logger?.error(
            {
              error: err,
              entityId: user.entityId,
              challengeId,
            },
            'error updating challenge to complete',
          )
          throw Trpc.handleStatus(
            500,
            'server failed to mark challenge as complete',
          )
        })

      return { success: true }
    })

  public readonly getContract = 'getContract' as const
  public readonly getContractController = this.trpc.procedure
    .use(isPrivyAuthed(this.trpc))
    .input(
      this.z.object({
        contractId: this.z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { contractId } = input
      const { user } = ctx.session

      assertUserAuthenticated(user)

      const contract = await getActiveContract({
        db: this.trpc.database,
        contractId,
        entityId: user.entityId,
      }).catch((err) => {
        metrics.fetchContractErrorCount.inc()
        this.logger?.error(
          {
            error: err,
            entityId: user.entityId,
            contractId,
          },
          'error fetching contract',
        )
        throw Trpc.handleStatus(500, 'error fetching contract')
      })

      if (!contract) {
        throw Trpc.handleStatus(400, 'contract does not exist')
      }

      return addRebateEligibilityToContract(contract)
    })

  public readonly deleteContractRoute = 'deleteContract' as const
  public readonly deleteContractController = this.trpc.procedure
    .use(isPrivyAuthed(this.trpc))
    .input(
      this.z.object({
        contractId: this.z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { user } = ctx.session
      const { contractId } = input
      assertUserAuthenticated(user)

      await deleteContract({
        db: this.trpc.database,
        contractId,
        entityId: user.entityId,
      }).catch((err) => {
        metrics.deleteContractErrorCount.inc()
        this.logger?.error(
          {
            error: err,
            entityId: user.entityId,
            contractId,
          },
          'error deleting contract',
        )
        throw Trpc.handleStatus(500, 'error deleting contract')
      })

      return { success: true }
    })

  public readonly handler = this.trpc.router({
    [this.listContractsForApp]: this.listContractsForAppController,
    [this.createContract]: this.createContractController,
    [this.startVerification]: this.startVerificationController,
    [this.completeVerification]: this.completeVerificationController,
  })
}
