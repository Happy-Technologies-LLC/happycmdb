// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JWT Token utility functions
 * Handles token storage, retrieval, decoding, and validation
 */

interface DecodedToken {
  id: string;
  email: string;
  roles: string[];
  iat: number;
  exp: number;
}

const TOKEN_KEY = 'auth_token';

/**
 * Retrieves the JWT token from localStorage
 */
export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (error) {
    console.error('Error retrieving token:', error);
    return null;
  }
};

/**
 * Stores the JWT token in localStorage
 */
export const setToken = (token: string): void => {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (error) {
    console.error('Error storing token:', error);
  }
};

/**
 * Removes the JWT token from localStorage
 */
export const removeToken = (): void => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    console.error('Error removing token:', error);
  }
};

/**
 * Decodes a JWT token without verification
 * Returns null if token is invalid
 */
export const decodeToken = (token: string): DecodedToken | null => {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = parts[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));

    return decoded as DecodedToken;
  } catch (error) {
    console.error('Error decoding token:', error);
    return null;
  }
};

/**
 * Checks if a JWT token is expired
 * Returns true if expired or invalid
 */
export const isTokenExpired = (token: string): boolean => {
  const decoded = decodeToken(token);

  if (!decoded || !decoded.exp) {
    return true;
  }

  // exp is in seconds, Date.now() is in milliseconds
  const expirationTime = decoded.exp * 1000;
  const currentTime = Date.now();

  return currentTime >= expirationTime;
};

/**
 * Checks if the token contains at least one of the specified roles
 * @param token - JWT token string
 * @param roles - Array of roles to check against
 * @returns true if user has at least one of the specified roles
 */
export const hasRole = (token: string, roles: string[]): boolean => {
  const decoded = decodeToken(token);

  if (!decoded || !decoded.roles || !Array.isArray(decoded.roles)) {
    return false;
  }

  return roles.some(role => decoded.roles.includes(role));
};

/**
 * Gets user info from the current stored token
 */
export const getUserFromToken = (): DecodedToken | null => {
  const token = getToken();

  if (!token || isTokenExpired(token)) {
    return null;
  }

  return decodeToken(token);
};
