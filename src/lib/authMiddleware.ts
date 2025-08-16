import { Request, Response, NextFunction } from 'express'
import { Logger } from '../types.js'

export interface AuthMiddlewareOptions {
  authToken?: string
  logger: Logger
}

export const createAuthMiddleware = ({
  authToken,
  logger,
}: AuthMiddlewareOptions) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth if no token is configured
    if (!authToken) {
      return next()
    }

    const authHeader = req.headers.authorization
    if (!authHeader) {
      logger.error(
        `Unauthorized request from ${req.ip}: missing Authorization header`,
      )
      res.status(401).json({
        error: 'Unauthorized: Missing Authorization header',
      })
      return
    }

    const expectedBearer = `Bearer ${authToken}`
    if (authHeader !== expectedBearer) {
      logger.error(
        `Unauthorized request from ${req.ip}: invalid Authorization header`,
      )
      res.status(401).json({
        error: 'Unauthorized: Invalid Authorization header',
      })
      return
    }

    // Auth successful, continue to next middleware
    next()
  }
}
