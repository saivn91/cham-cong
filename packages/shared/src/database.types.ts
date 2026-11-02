export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      audit_log: {
        Row: {
          id: string
          table_name: string
          row_id: string
          action: string
          old_data: Json | null
          new_data: Json | null
          actor_id: string | null
          branch_id: string | null
          created_at: string
        }
        Insert: {
          id?: string
          table_name: string
          row_id: string
          action: string
          old_data?: Json | null
          new_data?: Json | null
          actor_id?: string | null
          branch_id?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          table_name?: string
          row_id?: string
          action?: string
          old_data?: Json | null
          new_data?: Json | null
          actor_id?: string | null
          branch_id?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          }
        ]
      }
      branches: {
        Row: {
          id: string
          code: string
          name: string
          address: string | null
          created_at: string
        }
        Insert: {
          id?: string
          code: string
          name: string
          address?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          code?: string
          name?: string
          address?: string | null
          created_at?: string
        }
        Relationships: []
      }
      device_pairings: {
        Row: {
          id: string
          code_hash: string
          device_id: string | null
          expires_at: string
          used_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          code_hash: string
          device_id?: string | null
          expires_at: string
          used_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          code_hash?: string
          device_id?: string | null
          expires_at?: string
          used_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "device_pairings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          }
        ]
      }
      devices: {
        Row: {
          id: string
          auth_user_id: string | null
          branch_id: string
          name: string
          revoked_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          auth_user_id?: string | null
          branch_id: string
          name: string
          revoked_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          auth_user_id?: string | null
          branch_id?: string
          name?: string
          revoked_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          }
        ]
      }
      employee_pins: {
        Row: {
          employee_id: string
          pin_hash: string
          pin_failed: number
          pin_lock_until: string | null
          updated_at: string
        }
        Insert: {
          employee_id: string
          pin_hash: string
          pin_failed?: number
          pin_lock_until?: string | null
          updated_at?: string
        }
        Update: {
          employee_id?: string
          pin_hash?: string
          pin_failed?: number
          pin_lock_until?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_pins_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: true
            referencedRelation: "employees"
            referencedColumns: ["id"]
          }
        ]
      }
      employees: {
        Row: {
          id: string
          employee_code: string
          full_name: string
          role: Database["public"]["Enums"]["employee_role"]
          hourly_rate: number
          fixed_allowance: number
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          employee_code: string
          full_name: string
          role?: Database["public"]["Enums"]["employee_role"]
          hourly_rate?: number
          fixed_allowance?: number
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          employee_code?: string
          full_name?: string
          role?: Database["public"]["Enums"]["employee_role"]
          hourly_rate?: number
          fixed_allowance?: number
          is_active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      holidays: {
        Row: {
          id: string
          date: string
          name: string
          rate: number
          created_at: string
        }
        Insert: {
          id?: string
          date: string
          name: string
          rate?: number
          created_at?: string
        }
        Update: {
          id?: string
          date?: string
          name?: string
          rate?: number
          created_at?: string
        }
        Relationships: []
      }
      manager_branches: {
        Row: {
          manager_id: string
          branch_id: string
        }
        Insert: {
          manager_id: string
          branch_id: string
        }
        Update: {
          manager_id?: string
          branch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "manager_branches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "manager_branches_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          }
        ]
      }
      monthly_allowances: {
        Row: {
          id: string
          period_id: string
          employee_id: string
          amount: number
          reason: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          period_id: string
          employee_id: string
          amount: number
          reason?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          period_id?: string
          employee_id?: string
          amount?: number
          reason?: string | null
          created_by?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_allowances_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_allowances_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_allowances_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "payroll_periods"
            referencedColumns: ["id"]
          }
        ]
      }
      payroll: {
        Row: {
          id: string
          period_id: string
          employee_id: string
          hourly_rate_snapshot: number
          fixed_allowance_snapshot: number
          minutes_regular_day: number
          minutes_regular_night: number
          minutes_ot_day: number
          minutes_ot_night: number
          minutes_holiday_day: number
          minutes_holiday_night: number
          total_allowance: number
          total_salary: number
          calculated_at: string
        }
        Insert: {
          id?: string
          period_id: string
          employee_id: string
          hourly_rate_snapshot: number
          fixed_allowance_snapshot: number
          minutes_regular_day?: number
          minutes_regular_night?: number
          minutes_ot_day?: number
          minutes_ot_night?: number
          minutes_holiday_day?: number
          minutes_holiday_night?: number
          total_allowance?: number
          total_salary?: number
          calculated_at?: string
        }
        Update: {
          id?: string
          period_id?: string
          employee_id?: string
          hourly_rate_snapshot?: number
          fixed_allowance_snapshot?: number
          minutes_regular_day?: number
          minutes_regular_night?: number
          minutes_ot_day?: number
          minutes_ot_night?: number
          minutes_holiday_day?: number
          minutes_holiday_night?: number
          total_allowance?: number
          total_salary?: number
          calculated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "payroll_periods"
            referencedColumns: ["id"]
          }
        ]
      }
      payroll_periods: {
        Row: {
          id: string
          year: number
          month: number
          status: Database["public"]["Enums"]["payroll_period_status"]
          approved_by: string | null
          approved_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          year: number
          month: number
          status?: Database["public"]["Enums"]["payroll_period_status"]
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          year?: number
          month?: number
          status?: Database["public"]["Enums"]["payroll_period_status"]
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payroll_periods_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          }
        ]
      }
      punches: {
        Row: {
          id: string
          employee_id: string
          device_id: string | null
          branch_id: string
          type: Database["public"]["Enums"]["punch_type"]
          at: string
          source: Database["public"]["Enums"]["punch_source"]
          created_by: string | null
          reason: string | null
          corrects_punch_id: string | null
          voided_at: string | null
          voided_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          employee_id: string
          device_id?: string | null
          branch_id: string
          type: Database["public"]["Enums"]["punch_type"]
          at?: string
          source?: Database["public"]["Enums"]["punch_source"]
          created_by?: string | null
          reason?: string | null
          corrects_punch_id?: string | null
          voided_at?: string | null
          voided_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          employee_id?: string
          device_id?: string | null
          branch_id?: string
          type?: Database["public"]["Enums"]["punch_type"]
          at?: string
          source?: Database["public"]["Enums"]["punch_source"]
          created_by?: string | null
          reason?: string | null
          corrects_punch_id?: string | null
          voided_at?: string | null
          voided_by?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "punches_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "punches_corrects_punch_id_fkey"
            columns: ["corrects_punch_id"]
            isOneToOne: false
            referencedRelation: "punches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "punches_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "punches_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "punches_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "punches_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          }
        ]
      }
      shift_templates: {
        Row: {
          id: string
          branch_id: string
          name: string
          start_time: string
          end_time: string
          created_at: string
        }
        Insert: {
          id?: string
          branch_id: string
          name: string
          start_time: string
          end_time: string
          created_at?: string
        }
        Update: {
          id?: string
          branch_id?: string
          name?: string
          start_time?: string
          end_time?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_templates_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          }
        ]
      }
      shifts: {
        Row: {
          id: string
          employee_id: string
          branch_id: string
          during: string
          start_at: string
          end_at: string
          status: Database["public"]["Enums"]["shift_status"]
          note: string | null
          approved_by: string | null
          approved_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          employee_id: string
          branch_id: string
          during?: string
          start_at: string
          end_at: string
          status?: Database["public"]["Enums"]["shift_status"]
          note?: string | null
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          employee_id?: string
          branch_id?: string
          during?: string
          start_at?: string
          end_at?: string
          status?: Database["public"]["Enums"]["shift_status"]
          note?: string | null
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shifts_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_branch_id_fkey"
            columns: ["branch_id"]
            isOneToOne: false
            referencedRelation: "branches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          }
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      approve_shifts: {
        Args: {
          p_shift_ids: string[]
        }
        Returns: undefined
      }
      approve_timesheet: {
        Args: {
          p_period_id: string
        }
        Returns: undefined
      }
      change_pin: {
        Args: {
          p_old_pin: string
          p_new_pin: string
        }
        Returns: Json
      }
      consume_pairing_code: {
        Args: {
          p_code_hash: string
        }
        Returns: Json
      }
      correct_punch: {
        Args: {
          p_punch_id: string
          p_new_at: string
          p_reason: string
        }
        Returns: string
      }
      employee_directory: {
        Args: Record<PropertyKey, never>
        Returns: {
          id: string
          employee_code: string
          full_name: string
          role: string
          is_active: boolean
        }[]
      }
      kiosk_lookup: {
        Args: {
          p_employee_code: string
        }
        Returns: Json
      }
      kiosk_punch: {
        Args: {
          p_employee_code: string
          p_pin: string
          p_action: string
        }
        Returns: Json
      }
      new_pairing_code: {
        Args: {
          p_code_hash: string
          p_branch_id: string
          p_device_name: string
        }
        Returns: Json
      }
      preview_timesheet: {
        Args: {
          p_period_id: string
          p_employee_id?: string
        }
        Returns: Json
      }
      reset_pin: {
        Args: {
          p_employee_id: string
          p_new_pin: string
        }
        Returns: Json
      }
    }
    Enums: {
      employee_role: "employee" | "manager" | "admin"
      payroll_period_status: "open" | "approved"
      punch_source: "kiosk" | "manual"
      punch_type: "clock_in" | "break_start" | "break_end" | "clock_out"
      shift_status: "pending" | "approved" | "rejected"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type PublicSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (PublicSchema["Tables"] &
        PublicSchema["Views"])
    ? (PublicSchema["Tables"] &
        PublicSchema["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof PublicSchema["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
    ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof PublicSchema["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema["Enums"]
    ? PublicSchema["Enums"][PublicEnumNameOrOptions]
    : never
