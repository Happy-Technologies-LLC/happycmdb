// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import {
  GraphQLError, SchemaMetaFieldDef, TypeMetaFieldDef, TypeNameMetaFieldDef,
  getNamedType, isCompositeType, isInterfaceType, isListType, isNonNullType, isObjectType,
  valueFromASTUntyped,
  type DocumentNode, type FieldNode, type FragmentDefinitionNode,
  type GraphQLCompositeType, type GraphQLSchema, type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';

import { defaultGraphQLPageSize, MAX_GRAPHQL_PAGE_SIZE } from './pagination';

const MAX_DEPTH = 8;
const MAX_ALIASES = 20;
const MAX_FIELDS = 100;
const MAX_COMPLEXITY = 500;
const isPageSize = (name: string): boolean => name === 'limit' || name === 'first' || name === '_limit';

function limitExceeded(): never {
  throw new GraphQLError('GraphQL request limit exceeded', {
    extensions: { code: 'GRAPHQL_REQUEST_LIMIT_EXCEEDED', http: { status: 400 } },
  });
}

/** Count expanded fragment selections and estimate nested resolver fan-out before execution. */
export function enforceGraphQLRequestLimits(
  operation: OperationDefinitionNode,
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown> | undefined,
  resolverFields: Record<string, unknown>
): void {
  const root = operation.operation === 'mutation' ? schema.getMutationType() : schema.getQueryType();
  if (!root) return;
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === 'FragmentDefinition') fragments.set(definition.name.value, definition);
  }
  const visiting = new Set<string>();
  let fields = 0;
  let aliases = 0;

  // Projection fields are constant; only resolver-bearing composite work fans out.
  // Keep both components so scalar leaves never become N+1 database statements.
  const costOf = (
    selectionSet: SelectionSetNode, parent: GraphQLCompositeType, depth: number,
    wrapperPageSize?: number
  ): { projection: number; work: number } => {
    let projection = 0;
    let work = 0;
    for (const selection of selectionSet.selections) {
      if (selection.kind === 'FragmentSpread') {
        const name = selection.name.value;
        if (visiting.has(name)) limitExceeded();
        const fragment = fragments.get(name);
        if (!fragment) limitExceeded();
        const type = schema.getType(fragment.typeCondition.name.value);
        if (!type || !isCompositeType(type)) limitExceeded();
        visiting.add(name);
        const cost = costOf(fragment.selectionSet, type, depth, wrapperPageSize);
        visiting.delete(name);
        projection += cost.projection;
        work += cost.work;
      } else if (selection.kind === 'InlineFragment') {
        const type = selection.typeCondition
          ? schema.getType(selection.typeCondition.name.value) : parent;
        if (!type || !isCompositeType(type)) limitExceeded();
        const cost = costOf(selection.selectionSet, type, depth, wrapperPageSize);
        projection += cost.projection;
        work += cost.work;
      } else {
        const field: FieldNode = selection;
        fields++;
        if (field.alias) aliases++;
        if (fields > MAX_FIELDS || aliases > MAX_ALIASES || depth + 1 > MAX_DEPTH) limitExceeded();
        const name = field.name.value;
        const definition = name === '__typename' ? TypeNameMetaFieldDef
          : name === '__schema' ? SchemaMetaFieldDef
          : name === '__type' ? TypeMetaFieldDef
          : (isObjectType(parent) || isInterfaceType(parent) ? parent.getFields()[name] : undefined);
        if (!definition) limitExceeded();
        let type = definition.type;
        if (isNonNullType(type)) type = type.ofType;
        const list = isListType(type);
        const pageDefinition = definition.args.find(argument => isPageSize(argument.name));
        let pageSize = defaultGraphQLPageSize(name, pageDefinition?.defaultValue);
        const page = field.arguments?.find(argument => isPageSize(argument.name.value));
        if (page) {
          let value = valueFromASTUntyped(page.value, variables);
          if (value === undefined && page.value.kind === 'Variable') {
            const variableName = page.value.name.value;
            const variable = operation.variableDefinitions?.find(
              definition => definition.variable.name.value === variableName
            );
            if (variable?.defaultValue) value = valueFromASTUntyped(variable.defaultValue, variables);
          }
          if (typeof value === 'number' && value > MAX_GRAPHQL_PAGE_SIZE) limitExceeded();
          if (typeof value === 'number' && Number.isInteger(value) && value > 0) pageSize = value;
        }
        const childType = getNamedType(definition.type);
        const children = field.selectionSet && isCompositeType(childType)
          ? costOf(field.selectionSet, childType, depth + 1, !list && pageDefinition ? pageSize : undefined)
          : undefined;
        const pagedItems = list && name === 'items' && parent.name.endsWith('Page') && wrapperPageSize !== undefined;
        const fanout = list ? (pagedItems ? wrapperPageSize : pageSize) : 1;
        projection += 1 + (children?.projection ?? 0);
        // Apollo's schema builder attaches a default resolve function to plain properties.
        // Declared resolvers and introspection's built-in composite resolvers do work.
        const declared = resolverFields[parent.name] as Record<string, unknown> | undefined;
        const introspection = name === '__schema' || name === '__type' || parent.name.startsWith('__');
        if (children && (typeof declared?.[name] === 'function' || introspection)) {
          work += list ? fanout : 1;
        } else if (pagedItems) {
          work += fanout;
        }
        // This aggregate enumerates tenant graph incarnations before its SQL
        // query; one invocation per operation even when aliases are used.
        if (parent.name === 'AnalyticsQuery' && name === 'getChangeFrequencyByType') work += MAX_COMPLEXITY / 2;
        work += fanout * (children?.work ?? 0);
      }
      if (projection + work > MAX_COMPLEXITY) limitExceeded();
    }
    return { projection, work };
  };

  costOf(operation.selectionSet, root, 0);
}
