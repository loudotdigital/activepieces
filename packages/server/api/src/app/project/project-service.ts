import {
    ActivepiecesError,
    apId,
    ApId,
    assertNotNullOrUndefined,
    ErrorCode,
    isNil,
    NotificationStatus,
    PlatformRole,
    Project,
    ProjectId,
    spreadIfDefined,
    User,
    UserId,
} from '@activepieces/shared'
import { FindOptionsWhere, In, IsNull, Not } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { projectMemberService } from '../ee/project-members/project-member.service'
import { system } from '../helper/system/system'
import { userService } from '../user/user-service'
import { ProjectEntity } from './project-entity'
import { projectHooks } from './project-hooks'
export const projectRepo = repoFactory(ProjectEntity)

export const projectService = {
    async create(params: CreateParams): Promise<Project> {
        const newProject: NewProject = {
            id: apId(),
            ...params,
            notifyStatus: NotificationStatus.ALWAYS,
            releasesEnabled: false,
        }
        const savedProject = await projectRepo().save(newProject)
        await projectHooks.get(system.globalLogger()).postCreate(savedProject)
        return savedProject
    },

    async getOne(projectId: ProjectId | undefined): Promise<Project | null> {
        if (isNil(projectId)) {
            return null
        }

        return projectRepo().findOneBy({
            id: projectId,
            deleted: IsNull(),
        })
    },

    async update(projectId: ProjectId, request: UpdateParams): Promise<Project> {
        await assertExternalIdIsUnique(request.externalId, projectId)

        await projectRepo().update(
            {
                id: projectId,
                deleted: IsNull(),
            },
            {
                ...spreadIfDefined('externalId', request.externalId),
                ...spreadIfDefined('displayName', request.displayName),
                ...spreadIfDefined('notifyStatus', request.notifyStatus),
                ...spreadIfDefined('releasesEnabled', request.releasesEnabled),
            },
        )
        return this.getOneOrThrow(projectId)
    },

    async getPlatformId(projectId: ProjectId): Promise<string> {
        const result = await projectRepo().createQueryBuilder('project').select('"platformId"').where({
            id: projectId,
        }).getRawOne()
        const platformId = result?.platformId
        assertNotNullOrUndefined(platformId, 'platformId for project is undefined in webhook')
        return platformId
    },
    async getOneOrThrow(projectId: ProjectId): Promise<Project> {
        const project = await this.getOne(projectId)

        if (isNil(project)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: projectId,
                    entityType: 'project',
                },
            })
        }

        return project
    },
    async getUserProjectOrThrow(userId: UserId): Promise<Project> {
        const user = await userService.getOneOrFail({ id: userId })
        const projects = await this.getAllForUser(user)
        if (isNil(projects) || projects.length === 0) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: userId,
                    entityType: 'project',
                },
            })
        }
        return projects[0]
    },

    async getAllForUser(user: User): Promise<Project[]> {
        assertNotNullOrUndefined(user.platformId, 'platformId is undefined')
        const filters: FindOptionsWhere<Project>[] = []
        const projectIds = await projectMemberService(system.globalLogger()).getIdsOfProjects({
            platformId: user.platformId,
            userId: user.id,
        })
        switch (user.platformRole) {
            case PlatformRole.ADMIN:
                filters.push({
                    platformId: user.platformId,
                    deleted: IsNull(),
                })
                break
            case PlatformRole.MEMBER:
                filters.push({
                    ownerId: user.id,
                    platformId: user.platformId,
                    deleted: IsNull(),
                })
                break
        }
        if (!isNil(projectIds)) {
            filters.push({
                id: In(projectIds),
                deleted: IsNull(),
            })
        }
        return projectRepo().findBy(filters)
    },
    async addProjectToPlatform({ projectId, platformId }: AddProjectToPlatformParams): Promise<void> {
        const query = {
            id: projectId,
            deleted: IsNull(),
        }

        const update = {
            platformId,
        }

        await projectRepo().update(query, update)
    },

    async getByPlatformIdAndExternalId({
        platformId,
        externalId,
    }: GetByPlatformIdAndExternalIdParams): Promise<Project | null> {
        return projectRepo().findOneBy({
            platformId,
            externalId,
            deleted: IsNull(),
        })
    },
}


async function assertExternalIdIsUnique(externalId: string | undefined, projectId: ProjectId): Promise<void> {
    if (!isNil(externalId)) {
        const externalIdAlreadyExists = await projectRepo().existsBy({
            id: Not(projectId),
            externalId,
            deleted: IsNull(),
        })

        if (externalIdAlreadyExists) {
            throw new ActivepiecesError({
                code: ErrorCode.PROJECT_EXTERNAL_ID_ALREADY_EXISTS,
                params: {
                    externalId,
                },
            })
        }
    }
}

type GetIdsOfProjectsParams = {
    platformId: string
    userId: string
}

type UpdateParams = {
    displayName?: string
    externalId?: string
    notifyStatus?: NotificationStatus
    releasesEnabled?: boolean
}

type CreateParams = {
    ownerId: UserId
    displayName: string
    platformId: string
    externalId?: string
}

type GetByPlatformIdAndExternalIdParams = {
    platformId: string
    externalId: string
}

type AddProjectToPlatformParams = {
    projectId: ProjectId
    platformId: ApId
}

type NewProject = Omit<Project, 'created' | 'updated' | 'deleted'>
