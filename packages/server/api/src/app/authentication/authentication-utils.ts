import { ActivepiecesError, ApEdition, ApEnvironment, AuthenticationResponse, ErrorCode, isNil, PrincipalType, TelemetryEventName, User, UserIdentityProvider, UserStatus } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { system } from '../helper/system/system'
import { platformService } from '../platform/platform.service'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'
import { userInvitationsService } from '../user-invitations/user-invitation.service'
import { accessTokenManager } from './lib/access-token-manager'
import { userIdentityService } from './user-identity/user-identity-service'
import { AppSystemProp } from '../helper/system/system-prop'
import { Project, UserIdentity } from '@activepieces/shared'
import { telemetry } from '../helper/telemetry.utils'
import { flagService } from '../flags/flag.service'

export const authenticationUtils = {
    async assertUserIsInvitedToPlatformOrProject(log: FastifyBaseLogger, {
        email,
        platformId,
    }: AssertUserIsInvitedToPlatformOrProjectParams): Promise<void> {
        const isInvited = await userInvitationsService(log).hasAnyAcceptedInvitations({
            platformId,
            email,
        })
        if (!isInvited) {
            throw new ActivepiecesError({
                code: ErrorCode.INVITATION_ONLY_SIGN_UP,
                params: {
                    message: 'User is not invited to the platform',
                },
            })
        }
    },

    async getProjectAndToken(userId: string): Promise<AuthenticationResponse> {
        const user = await userService.getOneOrFail({ id: userId })
        const projects = await projectService.getAllForUser(user)
        if (projects.length === 0) {
            throw new ActivepiecesError({
                code: ErrorCode.INVITATION_ONLY_SIGN_UP,
                params: {
                    message: 'No project found for user',
                },
            })
        }
        const platform = await platformService.getOneOrThrow(projects[0].platformId)
        const identity = await userIdentityService(system.globalLogger()).getOneOrFail({ id: user.identityId })
        if (user.status === UserStatus.INACTIVE) {
            throw new ActivepiecesError({
                code: ErrorCode.USER_IS_INACTIVE,
                params: {
                    email: identity.email,
                },
            })
        }
        const token = await accessTokenManager.generateToken({
            id: user.id,
            type: PrincipalType.USER,
            projectId: projects[0].id,
            platform: {
                id: platform.id,
            },
            tokenVersion: identity.tokenVersion,
        })
        return {
            ...user,
            firstName: identity.firstName,
            lastName: identity.lastName,
            email: identity.email,
            trackEvents: identity.trackEvents,
            newsLetter: identity.newsLetter,
            verified: identity.verified,
            token,
            projectId: projects[0].id,
        }
    },

    async assertDomainIsAllowed({
        email,
        platformId,
    }: AssertDomainIsAllowedParams): Promise<void> {
        const edition = system.getEdition()
        if (edition === ApEdition.COMMUNITY) {
            return
        }
        const platform = await platformService.getOneOrThrow(platformId)
        if (!platform.ssoEnabled) {
            return
        }
        const emailDomain = email.split('@')[1]
        const isAllowedDomaiin =
            !platform.enforceAllowedAuthDomains ||
            platform.allowedAuthDomains.includes(emailDomain)

        if (!isAllowedDomaiin) {
            throw new ActivepiecesError({
                code: ErrorCode.DOMAIN_NOT_ALLOWED,
                params: {
                    domain: emailDomain,
                },
            })
        }
    },

    async assertEmailAuthIsEnabled({
        platformId,
        provider,
    }: AssertEmailAuthIsEnabledParams): Promise<void> {
        const edition = system.getEdition()
        if (edition === ApEdition.COMMUNITY) {
            return
        }
        const platform = await platformService.getOneOrThrow(platformId)
        if (!platform.ssoEnabled) {
            return
        }
        if (provider !== UserIdentityProvider.EMAIL) {
            return
        }
        if (!platform.emailAuthEnabled) {
            throw new ActivepiecesError({
                code: ErrorCode.EMAIL_AUTH_DISABLED,
                params: {},
            })
        }
    },

    async sendTelemetry({
        user,
        identity,
        project,
        log,
    }: SendTelemetryParams): Promise<void> {
        try {
            await telemetry(log).identify(user, identity, project.id)

            await telemetry(log).trackProject(project.id, {
                name: TelemetryEventName.SIGNED_UP,
                payload: {
                    userId: identity.id,
                    email: identity.email,
                    firstName: identity.firstName,
                    lastName: identity.lastName,
                    projectId: project.id,
                },
            })
        }
        catch (e) {
            log.warn({ name: 'AuthenticationService#sendTelemetry', error: e })
        }
    },

    async saveNewsLetterSubscriber(user: User, identity: UserIdentity, log: FastifyBaseLogger): Promise<void> {
        const isPlatformUserOrNotSubscribed = (!isNil(user.platformId) && !flagService.isCloudPlatform(user.platformId)) || !identity.newsLetter
        const environment = system.get(AppSystemProp.ENVIRONMENT)
        if (
            isPlatformUserOrNotSubscribed ||
            environment !== ApEnvironment.PRODUCTION
        ) {
            return
        }
        try {
            const response = await fetch(
                'https://us-central1-activepieces-b3803.cloudfunctions.net/addContact',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ email: identity.email }),
                },
            )
            return await response.json()
        }
        catch (error) {
            log.warn(error)
        }
    },
}

type SendTelemetryParams = {
    identity: UserIdentity
    user: User
    project: Project
    log: FastifyBaseLogger
}

type AssertDomainIsAllowedParams = {
    email: string
    platformId: string
}

type AssertEmailAuthIsEnabledParams = {
    platformId: string
    provider: UserIdentityProvider
}

type AssertUserIsInvitedToPlatformOrProjectParams = {
    email: string
    platformId: string
}