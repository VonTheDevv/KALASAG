import pg from 'pg'
import { databaseConfig } from './db-safety.mjs'

const { Client } = pg
const client = new Client(databaseConfig())

try {
  await client.connect()
  const tables = await client.query("select table_name from information_schema.tables where table_schema = 'public' order by table_name")
  const columns = await client.query("select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position")
  const policies = await client.query("select tablename, policyname, cmd, roles from pg_policies where schemaname = 'public' order by tablename, policyname")
  const functions = await client.query("select routine_name from information_schema.routines where routine_schema = 'public' order by routine_name")
  console.log(JSON.stringify({ tables: tables.rows, columns: columns.rows, policies: policies.rows, functions: functions.rows }, null, 2))
} finally {
  await client.end()
}
