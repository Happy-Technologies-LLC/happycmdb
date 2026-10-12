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

const MAX_DEPTH = 8;
const MAX_ALIASES = 20;
const MAX_FIELDS = 100;
const MAX_COMPLEXITY = 500;
const LIST_COST = 10;
const MAX_EXPLICIT_LIST_LIMIT = 100;

function limitExceeded(): never {
  throw new GraphQLError('GraphQL request limit exceeded', {
    extensions: { code: 'GRAPHQL_REQUEST_LIMIT_EXCEEDED', http: { status: 400 } },
  });
}

/** Count expanded fragment selections and estimate nested list fan-out before resolvers run. */
export function enforceGraphQLRequestLimits(
  operation: OperationDefinitionNode,
  document: DocumentNode,
  schema: GraphQLSchema,
  variables: Record<string, unknown> | undefined
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

  const costOf = (selectionSet: SelectionSetNode, parent: GraphQLCompositeType, depth: number): number => {
    let total = 0;
    for (const selection of selectionSet.selections) {
      if (selection.kind === 'FragmentSpread') {
        const name = selection.name.value;
        if (visiting.has(name)) limitExceeded();
        const fragment = fragments.get(name);
        if (!fragment) limitExceeded();
        const type = schema.getType(fragment.typeCondition.name.value);
        if (!type || !isCompositeType(type)) limitExceeded();
        visiting.add(name);
        total += costOf(fragment.selectionSet, type, depth);
        visiting.delete(name);
      } else if (selection.kind === 'InlineFragment') {
        const type = selection.typeCondition
          ? schema.getType(selection.typeCondition.name.value) : parent;
        if (!type || !isCompositeType(type)) limitExceeded();
        total += costOf(selection.selectionSet, type, depth);
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
        let weight = isListType(type) ? LIST_COST : 1;
        if (isListType(type)) {
          const pageLimit = field.arguments?.find(argument => argument.name.value === 'limit');
          if (pageLimit) {
            const value = valueFromASTUntyped(pageLimit.value, variables);
            if (typeof value === 'number' && value > MAX_EXPLICIT_LIST_LIMIT) limitExceeded();
            if (typeof value === 'number' && Number.isInteger(value) && value > weight) weight = value;
          }
        }
        const childType = getNamedType(definition.type);
        const children = field.selectionSet && isCompositeType(childType)
          ? costOf(field.selectionSet, childType, depth + 1) : 0;
        total += 1 + weight * children;
      }
      if (total > MAX_COMPLEXITY) limitExceeded();
    }
    return total;
  };

  costOf(operation.selectionSet, root, 0);
}
